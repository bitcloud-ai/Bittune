import {createConnection,type Socket} from "node:net";
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {createHash,randomUUID} from "node:crypto";
import {existsSync,lstatSync,mkdirSync,openSync,closeSync,readFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {resolveBittunePaths} from "../core/bittune-paths.ts";
import {VERSION} from "../config.ts";

export function taskSocketPath(){
 const p=resolveBittunePaths();const key=createHash("sha256").update(JSON.stringify([resolve(p.root),resolve(p.core),resolve(p.agent),resolve(p.sessions)])).digest("hex").slice(0,20);
 return join(tmpdir(),`bittune-${process.getuid?.() ?? "user"}-${key}.sock`);
}
export function workerEntry(){
 const here=dirname(fileURLToPath(import.meta.url));
 for(const path of [process.env.BITTUNE_TASK_WORKER,join(here,"task-worker.js"),resolve(here,"../../../../dist/task-worker.js")])if(path&&existsSync(path))return path;
 throw new Error("缺少共享任务构建产物，请构建或升级Bittune CLI。");
}
function checkSocket(path:string){if(!existsSync(path))return;const s=lstatSync(path);if(!s.isSocket()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw new Error("任务连接不属于当前用户或权限不正确。");}

export class TaskClient {
 private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
 private constructor(private socket:Socket){
  createInterface({input:socket,crlfDelay:Infinity}).on("line",line=>{let r:any;try{r=JSON.parse(line);}catch{return;}const p=this.pending.get(String(r.id));if(!p)return;this.pending.delete(String(r.id));if(r.error)p.reject(Object.assign(new Error(r.error.message),{code:r.error.code}));else p.resolve(r.result);});
  socket.on("close",()=>{for(const p of this.pending.values())p.reject(new Error("共享任务连接已关闭；任务结果保留，请重新查看状态。"));this.pending.clear();});
 }
 static async connect(start=true,matchVersion=true):Promise<TaskClient>{
  if(process.platform==="win32")throw new Error("共享后台任务目前支持Linux/macOS；原CLI交互入口仍可使用。");
  const path=taskSocketPath();checkSocket(path);
  const attempt=()=>new Promise<TaskClient>((resolve,reject)=>{const s=createConnection(path);s.once("error",reject);s.once("connect",()=>{s.removeListener("error",reject);s.on("error",()=>{});resolve(new TaskClient(s));});});
  let client:TaskClient|undefined;
  try{client=await attempt();}catch(error){if(!start)throw error;}
  if(!client){
   const p=resolveBittunePaths();mkdirSync(p.logs,{recursive:true,mode:0o700});const log=openSync(join(p.logs,"task-worker.log"),"a",0o600);
   const child=spawn(process.execPath,[workerEntry()],{cwd:process.cwd(),detached:true,stdio:["ignore",log,log],env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!["BITTUNE_HOST_API_TOKEN","SESSION_SECRET","OIDC_CLIENT_SECRET","BITTUNE_TASK_SCOPE_FILE"].includes(k)))});child.on("error",()=>{});child.unref();closeSync(log);
   const until=Date.now()+20000;while(Date.now()<until){await new Promise(r=>setTimeout(r,150));checkSocket(path);try{client=await attempt();break;}catch{}}
  }
  if(!client)throw new Error("共享任务进程未能启动，请查看Bittune日志目录中的task-worker.log。");
  const info=await client.request("engine_status",{});
  if(info.protocol!==1||(matchVersion&&(info.version!==VERSION||info.bundle_sha256!==createHash("sha256").update(readFileSync(workerEntry())).digest("hex")))){client.close();throw new Error("共享任务构建与CLI不一致；任务结束后运行bittune task worker stop，再重试以加载新构建。");}
  return client;
 }
 request(method:string,params:Record<string,any>={},signal?:AbortSignal):Promise<any>{
  if(this.isClosed())return Promise.reject(new Error("共享任务连接已关闭，请重新连接。"));
  const id=randomUUID();return new Promise((resolve,reject)=>{
   if(signal?.aborted){reject(new Error("请求已取消。"));return;}
   const cleanup=()=>signal?.removeEventListener("abort",cancel);
   const cancel=()=>{this.pending.delete(id);this.socket.write(JSON.stringify({id:randomUUID(),method:"cancel_request",params:{request_id:id}})+"\n");cleanup();reject(new Error("请求已取消。"));};
   this.pending.set(id,{resolve:value=>{cleanup();resolve(value);},reject:error=>{cleanup();reject(error);}});
   signal?.addEventListener("abort",cancel,{once:true});
   this.socket.write(JSON.stringify({id,method,params})+"\n",error=>{if(error){this.pending.delete(id);cleanup();reject(error);}});
  });
 }
 isClosed(){return this.socket.destroyed || this.socket.writableEnded;}
 close(){this.socket.end();}
}
