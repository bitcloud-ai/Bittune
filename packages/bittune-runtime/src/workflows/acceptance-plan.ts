import {createHash} from 'node:crypto';
import {validateTaskInput} from './task-input.ts';
import {tuningOutline} from './acceptance.ts';
/** A frozen, non-executing checklist over the actual product task contract. */
export function acceptancePlan(request:Record<string,any>){
 const frozen=structuredClone(request);validateTaskInput(frozen);
 const outline=tuningOutline(frozen),measured=frozen.kind==='quality'||(frozen.kind==='execute'&&frozen.mode!=='deploy');
 const groups=frozen.kind==='quality'?1:outline?.configurations??1;
 return {schema_version:'bittune-acceptance-plan-v1',request_sha256:'sha256:'+createHash('sha256').update(JSON.stringify(frozen)).digest('hex'),request:frozen,executed:false,status:'not_run',gpu_execution:'not_requested',
  budget:{formal_requests:measured?groups*frozen.request_count:0,warmup_requests:measured&&frozen.kind!=='quality'?groups:0,max_configurations:groups},
  steps:[
   {key:'hardware',label:'执行时由Bittune探测设备与占用，不停止其他任务',expected:'HardwareSnapshot与资源检查结果'},
   {key:'artifacts',label:'通过Bittune准备指定权重和固定镜像，校验计划',expected:'DeploymentPlan、Artifact与原生执行回执'},
   {key:'approval',label:'核对任务审批策略、设备范围与请求预算',expected:'冻结任务范围和实际审批记录'},
   {key:'service',label:'由Bittune启动受管模型，核对API与持久运行',expected:'ServiceInstance、就绪与API检查'},
   ...(measured?[{key:'measurement',label:frozen.kind==='quality'?'运行指定文本规则包':'按相同条件测量基准与候选',expected:frozen.kind==='quality'?'CorrectnessResult及规则包摘要':'BenchmarkResult、SuiteResult与测量完整性'}]:[]),
   ...(outline?[{key:'comparison',label:'由Core判断可比性，用户决定配置切换',expected:'Core comparison / Experiment，原始测量引用'}]:[]),
   {key:'report',label:'整理主报告与详细产物',expected:'Markdown主报告、校验后的详细ZIP'}
  ].map(step=>({...step,status:'not_run'})),
  notes:['此清单只校验请求格式，不启动任务、不下载、不占用GPU。','硬件适配、权重/镜像可用性、API访问与模型表现仍须实际执行时核验。','清单和软件协议模拟均不作为模型验收通过证据。']};
}
export function acceptancePlanMarkdown(p:ReturnType<typeof acceptancePlan>){return ['# 模型验收准备清单','',`任务：${p.request.name}`,`请求摘要：${p.request_sha256}`,'状态：尚未执行；需由用户明确提交任务。','',`预算：${p.budget.formal_requests}次正式请求，${p.budget.warmup_requests}次预热。`,'',...p.steps.map(s=>`- [ ] ${s.label}；留存${s.expected}。`),'',...p.notes.map(s=>'- '+s),''].join('\n');}
