import assert from "node:assert/strict";
import {createServer} from "node:net";
import {createInterface} from "node:readline";
import {mkdtemp,writeFile,chmod,access,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {test} from "node:test";
import {componentVersions} from "../packages/bittune-runtime/src/cli/version-info.ts";
import {taskSocketPath} from "../packages/bittune-runtime/src/workflows/task-client.ts";

test("版本查询不创建工作区；旧进程构建不匹配时只读提示并保留活跃任务",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bittune-versions-"));
  const overrides={BITTUNE_HOME:join(root,"workspace"),BITTUNE_CORE_HOME:join(root,"core"),BITTUNE_AGENT_DIR:join(root,"agent"),BITTUNE_SESSION_DIR:join(root,"sessions"),BITTUNE_TASK_WORKER:join(root,"expected-worker.js"),BITTUNE_CORE_PYTHON:process.env.BITTUNE_CORE_PYTHON||"python3",BITTUNE_CORE_MODULE_PATHS:resolve("packages/bittune-core/src"),BITTUNE_HOST_API_TOKEN:"fixture-private-not-in-version-output"};
  const previous=Object.fromEntries(Object.keys(overrides).map(k=>[k,process.env[k]]));
  Object.assign(process.env,overrides);
  await writeFile(overrides.BITTUNE_TASK_WORKER,"expected build");
  const methods:string[]=[],server=createServer(socket=>{
    createInterface({input:socket,crlfDelay:Infinity}).on("line",line=>{
      const request=JSON.parse(line);methods.push(request.method);
      socket.write(JSON.stringify({id:request.id,result:{protocol:1,version:"0.0.1",bundle_sha256:"a".repeat(64),active:true,inflight:1}})+"\n");
    });
  });
  try{
    const stopped=await componentVersions();
    assert.equal(stopped.worker.state,"not_running");
    assert.equal(stopped.core.state,"available");
    await assert.rejects(access(overrides.BITTUNE_HOME));
    await assert.rejects(access(overrides.BITTUNE_CORE_HOME));
    await new Promise<void>(resolve=>server.listen(taskSocketPath(),resolve));
    await chmod(taskSocketPath(),0o600);
    const current=await componentVersions();
    assert.equal(current.worker.state,"running");
    assert.equal(current.worker.build_matches,false);
    assert.equal(current.worker.active,true);
    assert.match(current.note,/保留当前任务/);
    assert.ok(server.listening);
    assert.deepEqual(methods,["engine_status","engine_status"]);
    assert.ok(!JSON.stringify(current).includes(overrides.BITTUNE_HOST_API_TOKEN));
    assert.ok(!JSON.stringify(current).includes(root));
    await assert.rejects(access(overrides.BITTUNE_CORE_HOME));
  }finally{
    if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
    for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
    await rm(root,{recursive:true,force:true});
  }
});
