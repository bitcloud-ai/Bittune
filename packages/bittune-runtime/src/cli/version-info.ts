import {createHash} from "node:crypto";
import {existsSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {getPackageDir,VERSION} from "../config.ts";
import {probeCore} from "../harness/core-client.ts";
import {TaskClient,workerEntry} from "../workflows/task-client.ts";

const sha256=(file:string)=>existsSync(file)?createHash("sha256").update(readFileSync(file)).digest("hex"):null;

/** Reads installed software and an already-running worker; never starts one. */
export async function componentVersions(){
  const dist=join(getPackageDir(),"dist");
  let core:{state:"available"|"unavailable";version:string|null};
  try{core={state:"available",version:probeCore().version};}
  catch{core={state:"unavailable",version:null};}
  let expectedWorker:string|null=null;
  try{expectedWorker=sha256(workerEntry());}catch{}
  let worker:{state:"running"|"not_running"|"unavailable";version:string|null;bundle_sha256:string|null;expected_sha256:string|null;build_matches:boolean|null;active:boolean|null}={state:"not_running",version:null,bundle_sha256:null,expected_sha256:expectedWorker,build_matches:null,active:null};
  let client:TaskClient|undefined;
  try{
    client=await TaskClient.connect(false,false);
    const status=await client.request("engine_status",{},AbortSignal.timeout(3000));
    worker={state:"running",version:status.version,bundle_sha256:status.bundle_sha256,expected_sha256:expectedWorker,build_matches:expectedWorker===null?null:status.bundle_sha256===expectedWorker&&status.version===VERSION,active:status.active};
  }catch(error){
    if(!["ENOENT","ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code || ""))worker.state="unavailable";
  }finally{client?.close();}
  return {
    schema_version:1,
    runtime:{version:VERSION,node_version:process.versions.node,cli_sha256:sha256(join(dist,"bittune.js")),bridge_sha256:sha256(join(dist,"web-bridge.js"))},
    core,worker,
    note:worker.build_matches===false?(worker.active?"后台任务进程仍在使用另一构建；保留当前任务，结束后再更新进程。":"后台任务进程与当前构建不同；可运行 bittune task worker stop 后按需重新连接。"):
      core.state==="unavailable"?"Core版本不可读取，请核对所选Python和Core安装。":worker.state==="not_running"?"后台任务进程未启动；查询版本不会启动它。":"版本信息已读取；版本号相同不代表所有组件构建相同或模型组合已经验收。",
  };
}
