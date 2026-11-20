import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {packageRegistry} from '../packages/bittune-runtime/src/workflows/capability-packages.ts';
import {selectionApplication} from '../packages/bittune-runtime/src/workflows/selection-application.ts';
import {applyFrozenPlanWithRecovery,type ManagedCall} from '../packages/bittune-runtime/src/workbench/service-switch.ts';
test('声明式包不导入代码、密钥或审批授权，批准后只生成任务参数并校验版本来源',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bittune-package-'));try{
  const manifest={schema_version:'bittune-capability-package-v1',name:'synthetic-metadata-only',version:'1.0.0',description:'CPU fixture, no model execution',required_tools:['inspect_environment'],required_skills:[],task_template:{kind:'prepare',mode:'deploy',name:'CPU fixture',goal:'Only validate declarations'}};
  assert.throws(()=>packageRegistry(dir,'import',{manifest:{...manifest,script:'bad'}},[]));
  assert.throws(()=>packageRegistry(dir,'import',{manifest:{...manifest,task_template:{...manifest.task_template,security_mode:'full'}}},[]));
  const entry:any=packageRegistry(dir,'import',{manifest,actor_ref:'fixture-owner'},[]);
  assert.throws(()=>packageRegistry(dir,'instantiate',{package_id:entry.package_id},[]));
  packageRegistry(dir,'preflight',{package_id:entry.package_id},[]);
  assert.throws(()=>packageRegistry(dir,'approve',{package_id:entry.package_id,allow_admin:false},[]));
  packageRegistry(dir,'approve',{package_id:entry.package_id,allow_admin:true},[]);
  const draft:any=packageRegistry(dir,'instantiate',{package_id:entry.package_id},[]);assert.equal(draft.execution_started,false);assert.equal(draft.request.security_mode,undefined);assert.equal(draft.request.source_package.content_hash,entry.content_hash);
  packageRegistry(dir,'retire',{package_id:entry.package_id,allow_admin:true},[]);assert.throws(()=>packageRegistry(dir,'check_source',draft.source_package,[]));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('选优应用预览绑定冻结计划与同模型同镜像运行时，保留零值差异且不执行',()=>{
 const model={model_id:'fixture/NOT-A-MODEL',revision:'fixed',quantization:'fixture'},runtime={runtime_kind:'vllm',image_digest:'fixed'},plan={id:'plan-fixture',payload:{model_ref:model,runtime_spec:runtime,status:'frozen',serving_spec:{cache:0}}},target={id:'service-target',payload:{ownership:'managed',plan_id:plan.id}},current={id:'service-current',payload:{ownership:'managed',desired:'running',observed_state:'ready',plan_id:'previous',model_ref:model,runtime_spec:runtime,serving_spec:{cache:1}}},selection={task_id:'fixture',recommended:{service_instance_id:target.id,suite_result_id:'suite-fixture'}};
 const p=selectionApplication(selection,target,plan,[current],current.id);assert.equal(p.execution_started,false);assert.equal(p.request?.plan_id,plan.id);assert.equal(p.differences[0]?.after,0);assert.throws(()=>selectionApplication(selection,target,plan,[{...current,payload:{...current.payload,runtime_spec:{runtime_kind:'sglang'}}}],current.id));
});
test('明确勾选后只恢复原方案和本次失败服务；取消或审批拒绝不触发恢复',async()=>{
 const calls:any[]=[];let created=0,started=0,sourceRunning=true;
 const call:ManagedCall=async(name,p)=>{calls.push([name,p]);if(name==='inspect_environment')return {data:{hardware_snapshot:{hardware_snapshot_id:'snapshot'}}};if(name==='plan_deployment'){if(p.action==='create')return {data:{plan:{plan_id:'fresh-'+(++created)}}};if(p.action==='validate')return {data:{validation:{state:'valid'}}};return {data:{}};}
 if(name==='inspect_service')return {data:{current_container_state:{running:p.service_instance_id==='failed-new'||sourceRunning,status:'exited'}}};
 if(name==='deploy_service'&&p.action==='stop'){if(p.service_instance_id==='original')sourceRunning=false;return {data:{service:{observed_state:'exited'}}};}
 if(name==='deploy_service'&&p.action==='start'){if(++started===1)throw Object.assign(Error('fixture startup failed'),{code:'service_not_ready',failed_service_id:'failed-new'});return {data:{service:{service_instance_id:'restored',endpoint:'http://127.0.0.1:12345'}}};}throw Error('unexpected call');};
 const result=await applyFrozenPlanWithRecovery(call,'original','target-plan','original-plan','fixture',{enabled:true,cancelled:()=>false});assert.equal(result.recovered,true);assert.equal(started,2);assert.deepEqual(calls.filter(c=>c[0]==='deploy_service'&&c[1].action==='stop').map(c=>c[1].service_instance_id),['original','failed-new']);assert.equal(calls.filter(c=>c[0]==='plan_deployment'&&c[1].action==='create').at(-1)[1].based_on_plan_id,'original-plan');
 calls.length=0;created=0;started=0;sourceRunning=true;
 await assert.rejects(()=>applyFrozenPlanWithRecovery(call,'original','target-plan','original-plan','fixture',{enabled:false,cancelled:()=>false}),/fixture startup failed/);assert.equal(started,1);assert.equal(created,1);
 let recovery=false;await assert.rejects(()=>applyFrozenPlanWithRecovery(async()=>{throw Object.assign(Error('denied'),{code:'approval_denied'});},'original','target','previous','fixture',{enabled:true,cancelled:()=>false,onRecovery:()=>{recovery=true;}}));assert.equal(recovery,false);
});
