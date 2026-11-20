import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {test} from "node:test";
import {createTaskEngine} from "../packages/bittune-runtime/src/workflows/task-engine.ts";

test("制品准备失败保留原因与凭据，继续同一任务需重新确认并可恢复历史", {timeout:60000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),"bittune-assets-")), bin=join(root,"bin");
  await mkdir(bin);
  // An isolated command fixture: no model, network, Docker or GPU operation.
  await writeFile(join(bin,"hf"),`#!/bin/sh
if [ ! -f "${root}/attempted" ]; then
  : > "${root}/attempted"
  printf '\\033[31mfixture download connection refused\\033[0m\\n' >&2
  exit 1
fi
printf 'fixture prepared\\n'
`,{mode:0o700});
  const overrides={BITTUNE_HOME:join(root,"state"),BITTUNE_AGENT_DIR:join(root,"state/agent"),BITTUNE_SESSION_DIR:join(root,"sessions"),BITTUNE_CORE_HOME:join(root,"core"),BITTUNE_WORKBENCH_CWD:root,BITTUNE_CORE_PYTHON:process.env.BITTUNE_CORE_PYTHON || "python3",BITTUNE_CORE_MODULE_PATHS:resolve("packages/bittune-core/src"),BITTUNE_MODEL_SOURCE:"huggingface",HF_HUB_CACHE:join(root,"models"),PATH:bin+":"+process.env.PATH};
  const previous=Object.fromEntries(Object.keys(overrides).map(k=>[k,process.env[k]]));
  Object.assign(process.env,overrides);
  let engine:Awaited<ReturnType<typeof createTaskEngine>>|undefined;
  const taskId=randomUUID();
  const task=()=>engine!.dispatch("task",{task_id:taskId}) as Promise<any>;
  async function until(predicate:(t:any)=>boolean){
    const deadline=Date.now()+20000;
    while(Date.now()<deadline){const value=await task();if(predicate(value))return value;await new Promise(r=>setTimeout(r,30));}
    assert.fail("Task did not reach the expected state");
  }
  try{
    engine=await createTaskEngine();
    await engine.dispatch("create",{task_id:taskId,kind:"assets",mode:"model",model_id:"fixture/example",name:"离线命令夹具",goal:"验证准备失败后的显式继续",security_mode:"manual"});
    const first=await until(t=>!!t.pending);
    await engine.dispatch("confirm",{task_id:taskId,confirmation_id:first.pending.confirmation_id,approved:true});
    const failed=await until(t=>t.state==="blocked"&&!engine!.isActive());
    assert.match(failed.error,/fixture download connection refused/);
    assert.ok(!failed.error.includes("\x1b"));
    assert.match(failed.summary,/未完成/);
    const originalRecords=failed.records.map((r:any)=>r.id);
    assert.equal(failed.records.filter((r:any)=>r.kind==="run").length,1);
    await engine.dispatch("continue",{task_id:taskId});
    const retry=await until(t=>!!t.pending);
    assert.equal(retry.task_id,taskId);
    assert.equal(retry.error,undefined);
    assert.equal(retry.summary,undefined);
    assert.notEqual(retry.pending.confirmation_id,first.pending.confirmation_id);
    assert.deepEqual(retry.records.map((r:any)=>r.id),originalRecords);
    await assert.rejects(engine.dispatch("confirm",{task_id:taskId,confirmation_id:first.pending.confirmation_id,approved:true}),/失效/);
    await engine.dispatch("confirm",{task_id:taskId,confirmation_id:retry.pending.confirmation_id,approved:true});
    const completed=await until(t=>t.state==="completed"&&!engine!.isActive());
    assert.equal(completed.records.filter((r:any)=>r.kind==="run").length,2);
    for(const id of originalRecords)assert.ok(completed.records.some((r:any)=>r.id===id));
    await assert.rejects(engine.dispatch("continue",{task_id:taskId}),/不能继续/);
    await engine.shutdown();engine=await createTaskEngine();
    const restored=await task();
    assert.equal(restored.state,"completed");
    assert.deepEqual(restored.records,completed.records);
    assert.ok(restored.events.some((e:any)=>e.type==="tool_error"&&e.message.includes("fixture download connection refused")));
    const failureArtifact=failed.records.find((r:any)=>r.kind==="artifact"&&r.payload.media_type==="text/plain");
    assert.ok(failureArtifact);
    const bytes:any=await engine.dispatch("artifact",{artifact_id:failureArtifact.id});
    assert.match(Buffer.from(bytes.data_base64,"base64").toString(),/fixture download connection refused/);
  }finally{
    await engine?.shutdown();
    for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
    await rm(root,{recursive:true,force:true});
  }
});
