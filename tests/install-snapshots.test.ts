import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,appendFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {createSoftwareSnapshot,restoreSoftwareSnapshot,listSoftwareSnapshots,readSoftwareSnapshot,lockInstallation} from "../packages/bittune-runtime/src/cli/install/snapshots.ts";
import {assertInstallationAvailable,assertDataOutsideSoftware} from "../packages/bittune-runtime/src/cli/install/guard.ts";
import {checkCatalog,runChecks} from "../packages/bittune-runtime/src/cli/install/checks.ts";
import {parseBittuneCliArguments} from "../packages/bittune-runtime/src/cli/bittune-args.ts";

test("软件安装模式不调用Docker、驱动或GPU探测",async()=>{
 const invocation=parseBittuneCliArguments(["install","--check-only","--software-only"]);
 assert.equal(invocation.kind,"install");if(invocation.kind!=="install")return;
 assert.equal(invocation.options.softwareOnly,true);
 const catalog=checkCatalog(),original=catalog.map(row=>row.probe),called:string[]=[];
 try{
  for(const row of catalog)row.probe=async()=>{called.push(row.id);return {id:row.id,label:row.label,state:"ok",detail:"fixture-only"};};
  const result=await runChecks({softwareOnly:invocation.options.softwareOnly});
  assert.deepEqual(called,catalog.filter(row=>row.scope!=="host").map(row=>row.id));
  assert.ok(result.length>0);
  assert.ok(!called.some(id=>["docker-daemon","nvidia-driver","nvidia-container-runtime"].includes(id)));
 }finally{catalog.forEach((row,index)=>{row.probe=original[index];});}
});

test("成套软件回退恢复CLI/Core/Node和入口，部分恢复失败可撤销，用户数据保留",async()=>{
 const root=await mkdtemp(join(tmpdir(),"bittune-snapshot-")),launcher=join(root,"bin/bittune");
 try{
  await mkdir(join(root,"bin"));
  for(const name of ["agent","py","node"]){await mkdir(join(root,name));await writeFile(join(root,name,"version"),"old-"+name);}
  await writeFile(launcher,"old-launcher",{mode:0o755});await mkdir(join(root,"core"));await writeFile(join(root,"core","data-sentinel"),"account/task/artifact data stays");
  const backup=await createSoftwareSnapshot(root,launcher);
  for(const name of ["agent","py","node"])await writeFile(join(root,name,"version"),"new-"+name);
  await writeFile(launcher,"new-launcher");
  // The CLI uses this progress callback too; inject a captured failure after Agent moved.
  await assert.rejects(restoreSoftwareSnapshot(root,backup.id,launcher,name=>{if(name==="py")throw new Error("fixture activation failure");}),/已恢复回退前的软件/);
  for(const name of ["agent","py","node"])assert.equal(await readFile(join(root,name,"version"),"utf8"),"new-"+name);
  assert.equal(await readFile(launcher,"utf8"),"new-launcher");
  const restored=await restoreSoftwareSnapshot(root,backup.id,launcher);
  for(const name of ["agent","py","node"])assert.equal(await readFile(join(root,name,"version"),"utf8"),"old-"+name);
  assert.equal(await readFile(launcher,"utf8"),"old-launcher");
  assert.equal(await readFile(join(restored.displaced_software,"py/version"),"utf8"),"new-py");
  assert.equal(await readFile(join(root,"core/data-sentinel"),"utf8"),"account/task/artifact data stays");
  assert.equal((await listSoftwareSnapshots(root))[0].status,"restored");
  await readSoftwareSnapshot(root,backup.id,launcher);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("损坏备份在变更前拒绝，安装锁阻止并行变更和新应用连接",async()=>{
 const root=await mkdtemp(join(tmpdir(),"bittune-snapshot-")),launcher=join(root,"launcher");
 try{
  const fresh=await createSoftwareSnapshot(root,launcher);
  await readSoftwareSnapshot(root,fresh.id,launcher);
  assert.deepEqual(fresh.components,{agent:false,py:false,node:false});
  await mkdir(join(root,"agent"));await writeFile(join(root,"agent/version"),"original");
  await assertDataOutsideSoftware(root,[join(root,"core")]);
  await assert.rejects(assertDataOutsideSoftware(root,[join(root,"agent/account-data")]),/数据与软件目录重叠/);
  const backup=await createSoftwareSnapshot(root,launcher);
  await appendFile(join(root,"backups",backup.id,"software.tar.gz"),"corrupted");
  await assert.rejects(restoreSoftwareSnapshot(root,backup.id,launcher),/摘要不匹配/);
  assert.equal(await readFile(join(root,"agent/version"),"utf8"),"original");
  const release=await lockInstallation(root);
  try{await assert.rejects(lockInstallation(root));await assert.rejects(assertInstallationAvailable(root),/正在安装或回退/);}
  finally{await release();}
  await assertInstallationAvailable(root);
 }finally{await rm(root,{recursive:true,force:true});}
});
