import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,rm,access} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {TaskClient} from "../packages/bittune-runtime/src/workflows/task-client.ts";
test("独立服务模式连接失败时不在Web组内另起worker",async()=>{
 const root=await mkdtemp(join(tmpdir(),"bittune-managed-worker-"));
 const values={BITTUNE_HOME:root,BITTUNE_AGENT_DIR:join(root,"agent"),BITTUNE_CORE_HOME:join(root,"core"),BITTUNE_SESSION_DIR:join(root,"sessions"),BITTUNE_LOG_DIR:join(root,"logs"),BITTUNE_INSTALL_ROOT:join(root,"install"),BITTUNE_TASK_WORKER_MANAGED:"1",BITTUNE_TASK_WORKER:join(root,"must-not-be-started.js")};
 const before=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);
 try{await assert.rejects(TaskClient.connect(),/后台任务服务尚未就绪/);await assert.rejects(access(join(root,"logs/task-worker.log")));}
 finally{for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(root,{recursive:true,force:true});}
});
