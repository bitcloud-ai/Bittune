import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptTaskMessage, dialogueContext, type DialogueTask } from "../packages/bittune-runtime/src/workbench/dialogue.ts";

const fixture = (): DialogueTask => ({ task_id:"task-fixture", state:"running", updated_at:"2026-01-01T00:00:00Z", request:{goal:"解释任务进度", request_count:4, model_path:"/private/weights", secret:"never-send"}, records:[{kind:"suite_result",id:"suite-example",payload:{credential:"never-send"}}],pending:{title:"approve",action:{secret:"never-send"}} });
test("task questions are idempotent, conflict on changed content, and preserve failed replies", () => {
  const task=fixture(), id="12345678-1234-1234-1234-123456789abc";
  const m=acceptTaskMessage(task,id," 当前进度？ ");
  assert.equal(acceptTaskMessage(task,id,"当前进度？"),m);
  assert.throws(()=>acceptTaskMessage(task,id,"更改预算"),/不同内容/);
  assert.throws(()=>acceptTaskMessage(task,"22345678-1234-1234-1234-123456789abc","另一问题"),/稍候/);
  m.state="failed";m.error="upstream unavailable";
  acceptTaskMessage(task,"22345678-1234-1234-1234-123456789abc","另一问题");
  assert.equal(task.messages?.length,2);assert.equal(task.messages?.[0].state,"failed");
});
test("dialogue context has no executable tools or private task payloads", () => {
  const task=fixture();acceptTaskMessage(task,"12345678-1234-1234-1234-123456789abc","提高预算");
  task.events=[{type:"tool_start",message:"deploy_service stop",at:"2026-01-01T00:00:00Z"},{type:"tool_result",message:"never-send /private/weights",at:"2026-01-01T00:00:01Z"},{type:"tool_start",message:"deploy_service stop /private/weights",at:"2026-01-01T00:00:02Z"}];
  const context=dialogueContext(task), json=JSON.stringify(context);
  assert.ok(json.includes("deploy_service stop"));
  assert.deepEqual(context.tools,[]);
  assert.ok(json.includes("suite-example"));assert.ok(json.includes('request_count'));
  for(const secret of ["never-send","/private/weights","credential"])assert.ok(!json.includes(secret));
  assert.equal(task.request.request_count,4);
});
