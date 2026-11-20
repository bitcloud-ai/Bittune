import {accountingView} from "./views.ts";

type Fact={kind?:string;id:string;payload:Record<string,any>};
type SourceTask={task_id:string;name:string;state:string;updated_at:string;request:Record<string,any>;records:Fact[];delivery_outputs?:{report_id:string;artifact_ids:string[]}[]};
export interface CostHistory {estimates:any[];unavailable:{artifact_id:string;reason:string}[];next_cursor:string|null}
const unique=(records:Fact[],kind:string)=>[...new Map(records.filter(r=>r.kind===kind).map(r=>[r.id,r])).values()];
const finite=(value:unknown):number|null=>typeof value==="number"&&Number.isFinite(value)?value:null;
export function tuningOutline(request:Record<string,any>){
 if(request.kind!=="execute"||request.mode!=="tune")return null;
 const latency=request.goal==="mean_ttft_ms",known=latency||request.goal==="output_tokens_per_second";
 return {objective:request.goal,label:known?(latency?"减少首字等待时间":"提高输出速度"):"目标见原任务",direction:known?(latency?"越低越好":"越高越好"):"未确定",input_tokens:request.input_tokens,output_tokens:request.output_tokens,concurrency:request.concurrency,configurations:1+request.max_trials,formal_requests:(1+request.max_trials)*request.request_count,warmup_requests:1+request.max_trials,
  conditions:"基准和候选沿用相同模型、输入/输出长度、并发、请求数与缓存条件；是否可比较以Core结论为准。",
  service_policy:"候选切换会中断当前服务API；最后成功启动的配置保持运行，应用或回滚由用户选择。",
  scope:"自动尝试支持输出速度和首字等待；已有结果可再按质量门槛或成本筛选推荐，不自动应用。"};
}

/** A read-only projection of saved sources, never a new acceptance fact or overall pass. */
export function acceptanceView(task:SourceTask,allTasks:SourceTask[],costs:CostHistory){
 const suites=unique(task.records,"suite_result");
 const services=new Set([...suites.map(s=>s.payload.service_instance_id),task.request.service_instance_id,...unique(task.records,"service_instance").map(s=>s.id)].filter((id):id is string=>!!id));
 const performance=suites.flatMap((s,index)=>(s.payload.rows || []).map((row:any)=>({suite_result_id:s.id,service_instance_id:s.payload.service_instance_id || null,configuration:task.request.mode==="tune"?(index===0?"基准配置":`候选配置${index}`):"性能测试",scenario_id:row.scenario_id,concurrency:row.concurrency,repeat:row.repeat ?? 1,...accountingView(row,1)})));
 const quality=allTasks.flatMap(t=>unique(t.records,"correctness_result").filter(r=>t.task_id===task.task_id || (t.request.kind==="quality"&&!!r.payload.service_instance_id&&services.has(r.payload.service_instance_id))).map(r=>{
  const p=r.payload,accuracy=finite(p.accuracy),threshold=finite(t.request.quality_threshold),complete=p.state==="healthy"&&accuracy!==null&&accuracy>=0&&accuracy<=1&&p.sample_count>0;
  return {result_id:r.id,task_id:t.task_id,task_name:t.name,service_instance_id:p.service_instance_id || null,relation:t.task_id===task.task_id?"本任务结果":"同一运行时的独立质量任务",pack_id:p.pack_id || null,pack_hash:p.pack_hash || null,sample_count:p.sample_count ?? null,hit_count:p.hit_count ?? null,accuracy:complete?accuracy:null,threshold,threshold_status:!complete||threshold===null?"not_assessed":accuracy!*100>=threshold?"met":"not_met",state:p.state,scoring_method:p.scoring_method || null};
 }));
 const reports=unique(task.records,"report").map(r=>{
  const bundles=allTasks.flatMap(t=>{
   const linked=t.request.kind==="delivery"?(t.request.source_report_id===r.id||t.request.report_ids?.includes(r.id)):t.records.filter(f=>f.kind==="report").at(-1)?.id===r.id;
   if(!linked)return [];
   const output=t.delivery_outputs?.find(d=>d.report_id===r.id);if(output)return t.records.filter(f=>f.kind==="artifact"&&output.artifact_ids.includes(f.id)&&f.payload.label==="report-bundle"&&f.payload.media_type==="application/zip").map(f=>f.id);
   const start=t.request.kind==="delivery"?0:t.records.findIndex(f=>f.kind==="report"&&f.id===r.id)+1;
   return t.records.slice(start).filter(f=>f.kind==="artifact"&&f.payload.label==="report-bundle"&&f.payload.media_type==="application/zip").map(f=>f.id);
  });
  return {report_id:r.id,title:r.payload.title || "模型验收报告",bundle_artifact_ids:[...new Set(bundles)]};
 });
 return {schema_version:"bittune-acceptance-summary-v1",task:{task_id:task.task_id,name:task.name,state:task.state,updated_at:task.updated_at},performance,quality,costs,reports,tuning:tuningOutline(task.request),
  notes:["任务执行状态不等于整体验收结论；未提供的项目保留为空。","不同配置分别展示，不合并重复请求或不同币种。","质量仅限指定规则包与运行时；成本和时长折算为估算，不是账单或生产容量。"]};
}
export type AcceptanceSummary=ReturnType<typeof acceptanceView>;
const n=(v:unknown)=>typeof v==="number"?v.toLocaleString("zh-CN",{maximumFractionDigits:4}):"未记录";
const line=(v:unknown)=>String(v??"").replace(/[\r\n]+/g," ").replace(/[<>`]/g,"");
export function acceptanceMarkdown(d:AcceptanceSummary){
 const lines=[`# ${line(d.task.name)} · 验收摘要`,"",`任务编号：${d.task.task_id}`,`执行状态：${({queued:"已排队",running:"运行中",waiting_confirmation:"等待确认",completed:"任务已结束",partial:"部分完成",failed:"失败",blocked:"执行受阻",cancelled:"已取消",interrupted:"已中断",prepared:"计划已校验",recommended:"推荐已生成"} as Record<string,string>)[d.task.state] || line(d.task.state)}`,`记录更新：${d.task.updated_at}`,"","## 性能与实际输出",""];
 if(!d.performance.length)lines.push("尚无本任务的已保存性能记录。");
 for(const p of d.performance){const o=p.observed;lines.push(`- ${p.configuration} · ${p.suite_result_id} · ${line(p.scenario_id)} · 并发${p.concurrency} · 第${p.repeat}次`, `  - 测量状态：${p.measurement_status==="complete"?"完整":"未完整或未记录"}；时延目标：${p.slo_status==="passed"?"达到本次设定":p.slo_status==="failed"?"未达到本次设定":"未提供判断"}`,`  - 输出速度：${n(o.output_tokens_per_second)} Token/秒；首字等待：${n(o.mean_ttft_ms)} ms`, `  - 实际输入/输出：${n(o.input_tokens_total)}/${n(o.output_tokens_total)} Token；请求/成功：${n(o.total_requests)}/${n(o.success_requests)}`,`  - 1小时输出折算：${n(p.estimated.output_tokens)} Token（估算）`);}
 lines.push("","## 文本规则质量","");if(!d.quality.length)lines.push("尚无可关联到本任务运行时的质量成绩。");
 for(const q of d.quality)lines.push(`- ${q.relation} · ${q.result_id} · 来源任务${q.task_id}`,`  - 规则包：${line(q.pack_id || "未记录")}；命中/样例：${n(q.hit_count)}/${n(q.sample_count)}；命中率：${q.accuracy===null?"未计算":n(q.accuracy*100)+"%"}`,`  - 用户阈值：${q.threshold===null?"未记录":n(q.threshold)+"%"}；${q.threshold_status==="met"?"达到所设阈值":q.threshold_status==="not_met"?"未达到所设阈值":"未作阈值判断"}`);
 lines.push("","## 成本估算","");if(!d.costs.estimates.length)lines.push("暂无可核验的成本估算。");
 for(const e of d.costs.estimates){const p=e.cost_projection;lines.push(`- ${n(p.cost_per_million_output_tokens)} ${line(p.inputs.currency)}/百万输出Token（估算） · ${e.artifact_id}`,`  - 当次费率：${n(p.inputs.gpu_hourly_price)} ${line(p.inputs.currency)}/GPU小时 × ${p.inputs.gpu_count}张GPU；来源${p.source.suite_result_id} · ${line(p.source.scenario_id)} · 并发${p.source.concurrency} · 第${p.source.repeat}次`);}
 for(const u of d.costs.unavailable)lines.push(`- ${u.artifact_id}：${u.reason}`);
 if(d.costs.next_cursor)lines.push(`还有更早核算记录：bittune accept cost-history --task ${d.task.task_id} --before ${d.costs.next_cursor}`);
 lines.push("","## 报告与交付文件","");if(!d.reports.length)lines.push("本任务尚无报告。");
 for(const r of d.reports)lines.push(`- ${line(r.title)} · ${r.report_id}`,`  - 阅读：bittune report show ${r.report_id}`,`  - 完整打包：bittune report export ${r.report_id}`,...r.bundle_artifact_ids.map(id=>`  - 已保存压缩包：${id}`));
 if(d.tuning)lines.push("","## 调优范围", "",`${d.tuning.label}（${d.tuning.direction}）；最多${d.tuning.configurations}套配置、${d.tuning.formal_requests}个正式请求，另有${d.tuning.warmup_requests}次预热。`,d.tuning.conditions,d.tuning.service_policy,d.tuning.scope);
 lines.push("","## 使用范围","",...d.notes.map(note=>`- ${note}`),"");return lines.join("\n");
}
