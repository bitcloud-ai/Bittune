import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluateScopedGeneric, compactReportResult, type TaskScope } from "../packages/bittune-runtime/src/harness/task-scope.ts";
import { createManagedTools } from "../packages/bittune-runtime/src/harness/managed-tools.ts";
import { CoreClient, CoreError } from "../packages/bittune-runtime/src/harness/core-client.ts";

const scope: TaskScope = { schema_version:1,allow_execution:false,plan_ids:[],service_instance_ids:[],record_ids:[],read_paths:[],scope_hash:"test",
	inventory_commands:["nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader"] };

test("host preparation command keeps approval and cannot expand to other shell actions", () => {
	const command="/opt/bittune/agent/skills/prepare-engine/scripts/prepare-engine.sh sglang lmsysorg/sglang@sha256:"+"b".repeat(64);
	const authorized={...scope,allow_execution:true,preparation_commands:[command]};
	const input={toolName:"bash" as const,command,cwd:"/tmp",protectedRoots:[]};
	assert.equal(evaluateScopedGeneric(input,authorized).decision,"ask");
	assert.equal(evaluateScopedGeneric({...input,command:command+"; docker ps"},authorized).decision,"deny");
	assert.equal(evaluateScopedGeneric(input,{...authorized,allow_execution:false}).decision,"deny");
});

test("restricted generic tools reject M2 commands, wrappers and writes; allow only exact inventory argv", async () => {
	for (const command of ["docker ps","docker image inspect vllm/vllm-openai","env docker ps","python3 -c 'import subprocess; subprocess.run([\"docker\",\"ps\"])'","echo ok; docker ps","$(docker ps)",scope.inventory_commands[0]+"\ndocker ps"]) {
		assert.equal(evaluateScopedGeneric({toolName:"bash",command,cwd:"/tmp",protectedRoots:[]},scope).decision,"deny",command);
	}
	assert.equal(evaluateScopedGeneric({toolName:"bash",command:scope.inventory_commands[0],cwd:"/tmp",protectedRoots:[]},scope).decision,"allow");
	const root=await mkdtemp(join(tmpdir(),"scope-"));const allowed=join(root,"profile.json");const outside=join(root,"outside.json");const link=join(root,"alias.json");
	await writeFile(allowed,"{}");await writeFile(outside,"{}");await symlink(outside,link);
	const local={...scope,read_paths:[await realpath(allowed)]};
	for (const path of [outside,link,root]) assert.equal(evaluateScopedGeneric({toolName:"read",path,cwd:root,protectedRoots:[]},local).decision,"deny");
	assert.equal(evaluateScopedGeneric({toolName:"read",path:allowed,cwd:root,protectedRoots:[]},local).decision,"allow");
	assert.equal(evaluateScopedGeneric({toolName:"write",path:allowed,cwd:root,protectedRoots:[]},local).decision,"deny");
	assert.equal(evaluateScopedGeneric({toolName:"read",path:allowed,cwd:root,protectedRoots:[root]},local).decision,"deny");
});

test("managed scope rejection precedes approval and actual Core operation", async () => {
	const calls:string[]=[];let approvals=0;
	const client={request:async (tool:string)=>{calls.push(tool);throw new CoreError("task_scope_denied","out of scope");}} as unknown as CoreClient;
	const tool=createManagedTools({client:()=>client},{taskScope:scope,askApproval:async()=>{approvals++;return true;}}).find(t=>t.name==="deploy_service")!;
	const result=await tool.execute("denied",{action:"start",plan_id:"plan-outside"},undefined,undefined,{sessionManager:{getSessionId:()=>"test"}} as never);
	assert.deepEqual(calls,["check_task_scope"]);assert.equal(approvals,0);assert.match(JSON.stringify(result),/task_scope_denied/);
});

test("compact report response retains identity/counts without returning large claim arrays", () => {
	const original={data:{report:{report_id:"report-full",title:"full",metric_claims:Array(31).fill({metric:"x"}),suite_claims:Array(110).fill({metric:"x"}),coverage:{version:"report-coverage-v1",mode:"all_suite_rows",metric_claims_count:31,suite_claims_count:110,suites:[{suite_result_id:"suite-test",rows:Array.from({length:12},()=>({numeric_claims:9,unavailable:{}}))}]},artifact_ids:["artifact-report"]}}};
	const compact=compactReportResult(original) as typeof original;
	assert.ok(JSON.stringify(compact).length<1500);assert.equal(compact.data.report.report_id,"report-full");
	assert.equal(compact.data.report.coverage.suite_claims_count,110);assert.equal(original.data.report.suite_claims.length,110);
	assert.equal((compact.data.report as {suite_claims?:unknown}).suite_claims,undefined);
	assert.throws(()=>compactReportResult({data:{report:{report_id:"old-core"}}}), (e:unknown)=>e instanceof CoreError&&e.code==="report_coverage_mismatch");
});

test("real JSONL Core restricts history discovery to host scope and keeps new report readable", async () => {
	const root=await mkdtemp(join(tmpdir(),"scope-core-"));const path=join(root,"scope.json");
	await writeFile(path,JSON.stringify({schema_version:1,allow_execution:false,plan_ids:[],service_instance_ids:[],record_ids:[],read_paths:[]}));
	const before=process.env.BITTUNE_TASK_SCOPE_FILE;process.env.BITTUNE_TASK_SCOPE_FILE=path;
	let client:CoreClient;
	try {client=await CoreClient.start({coreHome:join(root,"core"),modulePaths:[resolve("packages/bittune-core/src")]});}
	finally {if(before===undefined)delete process.env.BITTUNE_TASK_SCOPE_FILE;else process.env.BITTUNE_TASK_SCOPE_FILE=before;}
	try {
		const status=await client.request("task_scope_status",{},{sessionId:"scope-test"}) as {scope:TaskScope};assert.equal(status.scope.allow_execution,false);
		assert.deepEqual(await client.request("inspect_records",{kind:"service_instance"},{sessionId:"scope-test"}), {records:[]});
		const result=await client.request("write_report",{title:"scope-local",narrative:"No inference run",conclusion:"fixture"},{sessionId:"scope-test"}) as {data:{report:{report_id:string}}};
		const stored=await client.request("inspect_records",{kind:"report",id:result.data.report.report_id},{sessionId:"scope-test"});assert.ok(stored);
	} finally {await client.stop();}
});
