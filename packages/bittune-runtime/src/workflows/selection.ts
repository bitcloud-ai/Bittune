import {observedMetric} from "./views.ts";
import type {CostHistory} from "./acceptance.ts";
type Fact={kind?:string;id:string;payload:Record<string,any>};
type Task={task_id:string;name:string;request:Record<string,any>;records:Fact[];comparison?:Record<string,any>};
const number=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
/** Projection of saved native comparisons only. Never calls a model or applies a plan. */
export function selectSaved(task:Task,all:Task[],costs:CostHistory,input:{goal:string;threshold:number;currency:string;pack_hash:string}){
 if(!['quality','cost'].includes(input.goal)||!number(input.threshold)||input.threshold<0||input.threshold>100||!/^sha256:[a-f0-9]{64}$/.test(input.pack_hash)||!(/^[A-Z]{3}$/).test(input.currency))throw Object.assign(Error('需要选优目标、规则包摘要、0至100的质量阈值和三位币种。'),{code:'invalid_input'});
 const comparison=task.comparison,comparable=comparison?.comparable===true&&comparison?.claimable===true;
 const suites=[...new Map(task.records.filter(r=>r.kind==='suite_result').map(r=>[r.id,r])).values()];
 const authorized=new Set<string>(comparable?(comparison?.compared_benchmark_result_ids || comparison?.deltas?.map((d:any)=>d.benchmark_result_id) || []):[]);
 if(comparable){
  if(comparison?.baseline_benchmark_result_id)authorized.add(comparison.baseline_benchmark_result_id);
  const b=comparison?.baseline;
  if(b&&!comparison?.baseline_benchmark_result_id){
   const rows=suites.find(s=>s.id===b.suite_result_id)?.payload.rows?.filter((r:any)=>r.scenario_id===b.scenario_id&&r.concurrency===b.concurrency)??[];
   if(rows.length===1)authorized.add(rows[0].benchmark_result_id);
   else{
    // Older comparisons omit the baseline repeat. Recover it only from a matching saved experiment.
    const candidates=new Set(comparison?.deltas?.map((d:any)=>d.benchmark_result_id)??[]);
    const matching=new Set<string>();
    for(const {kind,payload} of task.records){
     if(kind!=='experiment')continue;
     const [baseline,...others]=payload.compared_benchmark_result_ids??[];
     if(typeof baseline==='string'&&baseline===payload.baseline_benchmark_result_id&&
      rows.some((r:any)=>r.benchmark_result_id===baseline)&&others.length===candidates.size&&
      others.every((id:string)=>candidates.has(id)))matching.add(baseline);
    }
    if(matching.size===1)for(const id of matching)authorized.add(id);
   }
  }
 }
 const quality=all.flatMap(t=>t.records.filter(r=>r.kind==='correctness_result').map(r=>r.payload)).sort((a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||'')));
 const reference=quality.filter(q=>suites.some(s=>s.payload.service_instance_id===q.service_instance_id&&s.payload.rows?.some((r:any)=>authorized.has(r.benchmark_result_id)))&&q.pack_hash===input.pack_hash&&q.state==='healthy'&&q.sample_count>0).at(-1);
 const rows=suites.flatMap(s=>(s.payload.rows || []).map((r:any)=>{
  const reasons:string[]=[];if(!comparable||!authorized.has(r.benchmark_result_id))reasons.push('没有覆盖该测量的Core可比结论');
  const speed=observedMetric(r,'output_tokens_per_second');if(r.measurement_status!=='complete'||!number(speed)||speed<=0)reasons.push('缺少完整的正数输出速度');
  const q=quality.filter(q=>q.service_instance_id===s.payload.service_instance_id&&q.pack_hash===input.pack_hash&&q.state==='healthy'&&q.sample_count>0&&number(q.accuracy)&&q.accuracy>=0&&q.accuracy<=1).at(-1);
  if(q&&reference&&(q.sample_count!==reference.sample_count||q.scoring_method!==reference.scoring_method))reasons.push('质量样例数量或评分方式不同');
  if(!q)reasons.push('该运行时没有所选规则包的质量成绩');else if(q.accuracy*100<input.threshold)reasons.push('质量成绩未达到指定阈值');
  const cost=costs.estimates.find(e=>{const p=e.cost_projection;return p.inputs.currency===input.currency&&p.source.suite_result_id===s.id&&p.source.benchmark_result_id===r.benchmark_result_id&&p.source.scenario_id===r.scenario_id&&p.source.concurrency===r.concurrency&&p.source.repeat===(r.repeat??1);});
  const amount=cost?.cost_projection.cost_per_million_output_tokens;
  if(input.goal==='cost'&&(!number(amount)||amount<0))reasons.push('该测量没有可核验的所选币种成本');
  return {suite_result_id:s.id,service_instance_id:s.payload.service_instance_id,scenario_id:r.scenario_id,concurrency:r.concurrency,repeat:r.repeat??1,benchmark_result_id:r.benchmark_result_id,quality_result_id:q?.correctness_result_id??null,accuracy:q?.accuracy??null,output_tokens_per_second:speed,cost_artifact_id:cost?.artifact_id??null,cost_per_million_output_tokens:number(amount)?amount:null,reasons,eligible:reasons.length===0};
 }));
 const eligible=rows.filter(r=>r.eligible).sort((a,b)=>input.goal==='cost'?a.cost_per_million_output_tokens!-b.cost_per_million_output_tokens!:b.accuracy!-a.accuracy! || b.output_tokens_per_second!-a.output_tokens_per_second!);
 return {schema_version:'bittune-saved-selection-v1',task_id:task.task_id,...input,recommended:eligible[0]??null,rows,cost_history_complete:!costs.next_cursor,applied:false,notes:['只比较本任务保存且Core允许比较的测量；质量必须来自同一运行时和规则包。','质量优先按规则命中率排序，同分时按输出速度；成本优先采用用户已保存费率，不换算币种。','这是推荐，不自动切换服务；缺项时先补相应成绩或成本核算。']};
}
