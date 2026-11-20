import {createHash,randomUUID} from "node:crypto";
import {createReadStream} from "node:fs";
import {mkdir,cp,rename,rm,readFile,writeFile,readdir,lstat,open} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";
import lockfile from "proper-lockfile";
import {runCommand} from "../../utils/command-runner.ts";

const components=["agent","py","node"] as const;
type Component=typeof components[number];
interface Snapshot {
  schema_version:1;id:string;created_at:string;install_root:string;launcher_path:string;
  components:Record<Component,boolean>;launcher_present:boolean;archive_sha256:string;
  status:"ready"|"installed"|"restored";
}
const validId=(id:string)=>/^install-\d{14}-[a-f0-9]{8}$/.test(id);
async function present(path:string){try{await lstat(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}}
async function digest(path:string){const hash=createHash("sha256");for await(const data of createReadStream(path))hash.update(data);return hash.digest("hex");}
async function save(path:string,data:unknown){
  const temp=path+".tmp-"+randomUUID();
  await writeFile(temp,JSON.stringify(data,null,2)+"\n",{mode:0o600});
  const file=await open(temp,"r");try{await file.sync();}finally{await file.close();}
  await rename(temp,path);
  const directory=await open(dirname(path),"r");try{await directory.sync();}finally{await directory.close();}
}
async function tar(args:string[]){const r=await runCommand("tar",args,{timeoutMs:600000,maxBytes:1024*1024});if(r.exit_code!==0)throw new Error("软件快照归档操作失败；原软件与快照已保留。");return r;}
export async function lockInstallation(root:string){
  await mkdir(root,{recursive:true});
  return lockfile.lock(root,{lockfilePath:join(root,".install.lock"),retries:0});
}
export async function createSoftwareSnapshot(root:string,launcher:string):Promise<Snapshot>{
  root=resolve(root);launcher=resolve(launcher);
  const id="install-"+new Date().toISOString().replace(/\D/g,"").slice(0,14)+"-"+randomUUID().slice(0,8);
  const home=join(root,"backups",id);await mkdir(home,{recursive:true,mode:0o700});
  const snapshot:Snapshot={schema_version:1,id,created_at:new Date().toISOString(),install_root:root,launcher_path:launcher,components:{agent:false,py:false,node:false},launcher_present:await present(launcher),archive_sha256:"",status:"ready"};
  const names:string[]=[];
  for(const name of components)if(snapshot.components[name]=await present(join(root,name)))names.push(name);
  const args=["-czf",join(home,"software.tar.gz"),"-C",root,...names];
  if(snapshot.launcher_present){await cp(launcher,join(home,"launcher"),{verbatimSymlinks:true,preserveTimestamps:true});args.push("-C",home,"launcher");}
  if(!names.length&&!snapshot.launcher_present)args.push("-T","/dev/null");
  await tar(args);
  const archive=await open(join(home,"software.tar.gz"),"r");try{await archive.sync();}finally{await archive.close();}
  snapshot.archive_sha256=await digest(join(home,"software.tar.gz"));
  await save(join(home,"snapshot.json"),snapshot);
  return snapshot;
}
export async function readSoftwareSnapshot(root:string,id:string,launcher:string):Promise<Snapshot>{
  if(!validId(id))throw new Error("软件备份编号无效。");
  const home=join(resolve(root),"backups",id),snapshot=JSON.parse(await readFile(join(home,"snapshot.json"),"utf8")) as Snapshot;
  if(snapshot.schema_version!==1||snapshot.id!==id||snapshot.install_root!==resolve(root)||snapshot.launcher_path!==resolve(launcher)||components.some(name=>typeof snapshot.components?.[name]!=="boolean")||typeof snapshot.launcher_present!=="boolean")throw new Error("软件备份不属于当前安装或格式不完整，未执行回退。");
  if(await digest(join(home,"software.tar.gz"))!==snapshot.archive_sha256)throw new Error("软件备份摘要不匹配，未执行回退。");
  return snapshot;
}
export async function listSoftwareSnapshots(root:string){
  let names:string[];try{names=await readdir(join(root,"backups"));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error;}
  const rows=[];
  for(const id of names.filter(validId).sort().reverse()){
    try{const s=JSON.parse(await readFile(join(root,"backups",id,"snapshot.json"),"utf8")) as Snapshot;if(s.schema_version===1&&s.id===id&&s.install_root===resolve(root))rows.push({id,created_at:s.created_at,status:s.status,components:s.components,launcher_present:s.launcher_present});}catch{rows.push({id,status:"unreadable"});}
  }
  return rows;
}
export async function markSoftwareSnapshot(root:string,id:string,status:Snapshot["status"]){
  if(!validId(id))throw new Error("软件备份编号无效。");
  const file=join(root,"backups",id,"snapshot.json"),s=JSON.parse(await readFile(file,"utf8")) as Snapshot;
  await save(file,{...s,status});
}
async function replaceLauncher(source:string,target:string){
  await mkdir(dirname(target),{recursive:true});const temp=target+".restore-"+randomUUID();
  try{await cp(source,temp,{verbatimSymlinks:true,preserveTimestamps:true});await rename(temp,target);}finally{await rm(temp,{force:true});}
}
/** Restores the software set, retaining displaced software and undoing partial restores. */
export async function restoreSoftwareSnapshot(root:string,id:string,launcher:string,onProgress?:(component:string)=>void){
  root=resolve(root);launcher=resolve(launcher);
  const snapshot=await readSoftwareSnapshot(root,id,launcher),home=join(root,"backups",id);
  const stage=join(root,"staging","restore-"+randomUUID()),old=join(stage,"displaced");await mkdir(old,{recursive:true,mode:0o700});
  const listing=await tar(["-tzf",join(home,"software.tar.gz")]);
  for(const entry of listing.stdout.split(/\r?\n/).filter(Boolean))if(entry.startsWith("/")||entry.split("/").includes("..")||![...components,"launcher"].includes(entry.split("/")[0] as Component))throw new Error("软件备份包含范围外的归档路径，未执行回退。");
  await tar(["-xzf",join(home,"software.tar.gz"),"-C",stage]);
  for(const name of components)if(snapshot.components[name]!==await present(join(stage,name)))throw new Error("软件备份缺少声明的组件，未执行回退。");
  if(snapshot.launcher_present!==await present(join(stage,"launcher")))throw new Error("软件备份缺少启动入口，未执行回退。");
  const moved:Component[]=[],applied:Component[]=[];let launcherChanged=false;
  const hadLauncher=await present(launcher);
  if(hadLauncher)await cp(launcher,join(old,"launcher"),{verbatimSymlinks:true,preserveTimestamps:true});
  try{
    for(const name of components){
      onProgress?.(name);
      if(await present(join(root,name))){await rename(join(root,name),join(old,name));moved.push(name);}
      if(snapshot.components[name]){await rename(join(stage,name),join(root,name));applied.push(name);}
    }
    onProgress?.("launcher");
    if(snapshot.launcher_present)await replaceLauncher(join(stage,"launcher"),launcher);else await rm(launcher,{force:true});
    launcherChanged=true;
    await markSoftwareSnapshot(root,id,"restored");
  }catch(error){
    const failures:unknown[]=[error];
    if(launcherChanged)try{if(hadLauncher)await replaceLauncher(join(old,"launcher"),launcher);else await rm(launcher,{force:true});}catch(e){failures.push(e);}
    for(const name of [...components].reverse())try{
      if(applied.includes(name))await rm(join(root,name),{recursive:true,force:true});
      if(moved.includes(name))await rename(join(old,name),join(root,name));
    }catch(e){failures.push(e);}
    throw new AggregateError(failures,failures.length===1?"软件回退未完成，已恢复回退前的软件。":"软件回退及自动恢复未完成，请保留暂存目录："+stage);
  }
  // Keep the displaced set for manual recovery instead of deleting the newer software.
  const displaced=join(home,"replaced-"+randomUUID());await rename(old,displaced);await rm(stage,{recursive:true,force:true});
  return {snapshot_id:id,status:"restored" as const,displaced_software:displaced,data_directories_changed:false};
}
