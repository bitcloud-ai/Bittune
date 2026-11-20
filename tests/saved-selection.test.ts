import assert from 'node:assert/strict';
import {test} from 'node:test';
import {selectSaved} from '../packages/bittune-runtime/src/workflows/selection.ts';
import {acceptancePlan} from '../packages/bittune-runtime/src/workflows/acceptance-plan.ts';
const pack='sha256:'+'a'.repeat(64),options={goal:'cost',threshold:80,currency:'CNY',pack_hash:pack};
const suite=(id:string,service:string,rate:number)=>({kind:'suite_result',id,payload:{service_instance_id:service,rows:[{benchmark_result_id:'benchmark-'+id,scenario_id:'fixed',concurrency:1,repeat:1,measurement_status:'complete',measurement:{metrics:{output_tokens_per_second:rate}}}]}});
const task:any={task_id:'fixture',name:'合成CPU用例，非实测',request:{},records:[suite('one','s1',10),suite('two','s2',20),suite('uncompared','s3',999)],comparison:{comparable:true,claimable:true,baseline:{suite_result_id:'one',scenario_id:'fixed',concurrency:1},deltas:[{benchmark_result_id:'benchmark-two'}]}};
const quality:any={task_id:'qa',name:'合成规则',request:{kind:'quality'},records:['s1','s2','s3','unrelated'].map(id=>({kind:'correctness_result',id:'qa-'+id,payload:{correctness_result_id:'qa-'+id,service_instance_id:id,pack_hash:pack,state:'healthy',sample_count:id==='s3'?2:5,accuracy:1}}))};
const costs:any={estimates:['one','two'].map((id,i)=>({artifact_id:id,cost_projection:{source:{suite_result_id:id,benchmark_result_id:'benchmark-'+id,scenario_id:'fixed',concurrency:1,repeat:1},inputs:{currency:'CNY'},cost_per_million_output_tokens:i?0:10}})),unavailable:[],next_cursor:null};
test('保存结果选优保留零费用，排除未比较结果、其他运行时质量与跨币种成本，不自动应用',()=>{
 const result=selectSaved(task,[task,quality],costs,options);assert.equal(result.recommended?.suite_result_id,'two');assert.equal(result.recommended?.cost_per_million_output_tokens,0);assert.equal(result.applied,false);assert.equal(result.rows[2]?.eligible,false);
 assert.equal(selectSaved({...task,comparison:{comparable:false,claimable:false}},[quality],costs,options).recommended,null);
 assert.equal(selectSaved(task,[quality],costs,{...options,currency:'USD'}).recommended,null);
 assert.equal(selectSaved(task,[quality],costs,{...options,pack_hash:'sha256:'+'b'.repeat(64)}).recommended,null);
});
test('多次测量时按已归档比较选择基线，排除同一工作点未参与的复测',()=>{
 const baseline=suite('one','s1',10);
 baseline.payload.rows.push({...baseline.payload.rows[0]!,repeat:2,benchmark_result_id:'benchmark-one-repeat-2'});
 const repeated={...task,records:[baseline,task.records[1],{
  kind:'experiment',id:'comparison-experiment',payload:{
   baseline_benchmark_result_id:'benchmark-one-repeat-2',
   compared_benchmark_result_ids:['benchmark-one-repeat-2','benchmark-two'],
  },
 }]};
 const result=selectSaved(repeated,[quality],costs,{...options,goal:'quality'});
 assert.equal(result.rows[0]!.eligible,false);
 assert.equal(result.rows[1]!.eligible,true);
 assert.equal(result.rows[2]!.eligible,true);
});
test('验收清单校验真实任务契约，冻结预算但全部标记未执行',()=>{
 const request:any={task_id:'11111111-1111-4111-8111-111111111111',name:'合成任务',goal:'output_tokens_per_second',kind:'execute',mode:'tune',plan_id:'plan-11111111-1111-4111-8111-111111111111',input_tokens:128,output_tokens:32,concurrency:1,request_count:2,max_trials:1};
 const p=acceptancePlan(request);assert.equal(p.executed,false);assert.equal(p.budget.formal_requests,4);assert.equal(p.budget.warmup_requests,2);assert(p.steps.every(s=>s.status==='not_run'));request.request_count=8;assert.equal(p.request.request_count,2);assert.throws(()=>acceptancePlan({...request,concurrency:0}));
});
