import assert from "node:assert/strict";
import {test} from "node:test";
import {accountingView} from "../packages/bittune-runtime/src/workflows/views.ts";
import {modelMessage} from "../packages/bittune-runtime/src/workflows/model-message.ts";
test("CLI/Web核算只取真实指标：保留零值，不以计划填补缺失",()=>{
 const row={measurement_status:"complete",metrics:{output_tokens_total:999},measurement:{metrics:{output_tokens_total:0,output_tokens_per_second:2}}};
 const d=accountingView(row,1);assert.equal(d.observed.output_tokens_total,0);assert.equal(d.observed.input_tokens_total,null);assert.equal(d.estimated.output_tokens,7200);
 assert.equal(accountingView({...row,measurement_status:"partial"},1).estimated.output_tokens,null);
});
test("CLI/Web模型回复不混入思考文本",()=>{
 assert.equal(modelMessage({content:"<think>内部推理</think>最终回复"}).content,"最终回复");
 assert.equal(modelMessage({content:"推理</think>最终回复"}).content,"最终回复");
});

import {acceptanceView,acceptanceMarkdown,tuningOutline} from "../packages/bittune-runtime/src/workflows/acceptance.ts";
test("验收摘要只关联同一运行时，保留零值、缺失项、币种与原始来源",()=>{
 const task:any={task_id:"fixture-task",name:"合成开发夹具（非模型实测）",state:"partial",updated_at:"2026-11-17T00:00:00Z",request:{kind:"execute",mode:"tune",goal:"mean_ttft_ms",service_instance_id:"service-one",max_trials:2,request_count:4,input_tokens:128,output_tokens:32,concurrency:1},records:[
  {kind:"suite_result",id:"suite-one",payload:{service_instance_id:"service-one",rows:[{scenario_id:"fixture",concurrency:1,repeat:1,measurement_status:"complete",metrics:{output_tokens_total:999},measurement:{metrics:{output_tokens_total:0,output_tokens_per_second:2}}}]}},
  {kind:"suite_result",id:"suite-two",payload:{service_instance_id:"service-two",rows:[{scenario_id:"fixture",concurrency:1,measurement_status:"partial",metrics:{output_tokens_per_second:999},measurement:{metrics:{}}}]}},
  {kind:"report",id:"report-one",payload:{title:"合成报告"}}]};
 const quality=(id:string,service:string,accuracy:number,state="healthy"):any=>({task_id:id,name:"合成规则评测",request:{kind:"quality",quality_threshold:80},records:[{kind:"correctness_result",id:"correct-"+id,payload:{service_instance_id:service,model_ref:{model_id:"same-name"},pack_id:"fixture",sample_count:5,hit_count:0,accuracy,state}}]});
 const cost=(currency:string,price:number)=>({artifact_id:"artifact-"+currency,cost_projection:{cost_per_million_output_tokens:price,inputs:{currency,gpu_hourly_price:price,gpu_count:1},source:{suite_result_id:"suite-one",scenario_id:"fixture",concurrency:1,repeat:1}}});
 const bundle:any={task_id:"delivery",request:{kind:"delivery",source_report_id:"report-one"},records:[{kind:"artifact",id:"artifact-zip",payload:{label:"report-bundle",media_type:"application/zip"}}]};
 const d=acceptanceView(task,[task,quality("own","service-one",0),quality("candidate","service-two",1,"blocked"),quality("other","service-unrelated",1),bundle,{...bundle,request:{kind:"delivery",source_report_id:"report-other"},records:[{...bundle.records[0],id:"wrong-bundle"}]}],{estimates:[cost("CNY",0),cost("USD",2)],unavailable:[{artifact_id:"damaged",reason:"无法核验"}],next_cursor:"older"});
 assert.equal(d.performance.length,2);assert.equal(d.performance[0].observed.output_tokens_total,0);assert.equal(d.performance[0].observed.input_tokens_total,null);assert.equal(d.performance[1].observed.output_tokens_per_second,null);assert.equal(d.performance[1].estimated.output_tokens,null);
 assert.deepEqual(d.quality.map(q=>q.task_id),["own","candidate"]);assert.equal(d.quality[0].accuracy,0);assert.equal(d.quality[0].threshold_status,"not_met");assert.equal(d.quality[1].accuracy,null);assert.equal(d.quality[1].threshold_status,"not_assessed");
 assert.deepEqual(d.reports[0].bundle_artifact_ids,["artifact-zip"]);assert.equal(d.tuning?.direction,"越低越好");assert.equal(d.tuning?.formal_requests,12);assert.equal(d.tuning?.warmup_requests,3);
 const md=acceptanceMarkdown(d);assert.match(md,/0 CNY/);assert.match(md,/2 USD/);assert.match(md,/damaged/);assert.match(md,/--before older/);assert.doesNotMatch(md,/service-unrelated|wrong-bundle|999|整体验收通过/);
});
test("只有质量或未完成任务时也能读摘要，不补造性能、报告和费用",()=>{
 const task:any={task_id:"empty",name:"合成空任务",state:"failed",updated_at:"now",request:{kind:"execute",mode:"deploy"},records:[]};
 const d=acceptanceView(task,[task],{estimates:[],unavailable:[],next_cursor:null});
 assert.deepEqual(d.performance,[]);assert.deepEqual(d.quality,[]);assert.deepEqual(d.reports,[]);assert.equal(d.tuning,null);assert.match(acceptanceMarkdown(d),/尚无本任务/);assert.equal(tuningOutline({kind:"execute",mode:"tune",goal:"custom",max_trials:0,request_count:1})?.direction,"未确定");
});
