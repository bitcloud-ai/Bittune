import {isDeepStrictEqual} from 'node:util';
export function selectionApplication(selection:any,target:any,plan:any,services:any[],currentId?:string){
 const error=(message:string):never=>{throw Object.assign(Error(message),{code:'invalid_input'});};
 if(!selection.recommended||selection.recommended.service_instance_id!==target.id||target.payload.ownership!=='managed'||plan.id!==target.payload.plan_id||plan.payload.status!=='frozen')error('推荐结果尚未绑定到有效的受管运行时与冻结计划。');
 const matches=services.filter(s=>s.payload.ownership==='managed'&&s.payload.desired!=='stopped'&&s.payload.observed_state==='ready'&&isDeepStrictEqual(s.payload.model_ref,plan.payload.model_ref)&&isDeepStrictEqual(s.payload.runtime_spec,plan.payload.runtime_spec));
 const current=currentId?matches.find(s=>s.id===currentId):undefined;if(currentId&&!current)error('当前运行时不满足同模型、同镜像或已记录就绪条件，请重新选择。');
 const labels:Record<string,string>={max_model_len:'上下文长度',context_length:'上下文长度',max_num_seqs:'最大同时序列数',gpu_memory_utilization:'显存使用比例',mem_fraction_static:'静态显存比例',enable_prefix_caching:'前缀缓存',disable_radix_cache:'关闭Radix缓存',tensor_parallel_size:'张量并行数',pipeline_parallel_size:'流水线并行数'};
 const before=current?.payload.serving_spec||{},after=plan.payload.serving_spec||{};
 const differences=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>!isDeepStrictEqual(before[k],after[k])).map(k=>({parameter:k,label:labels[k]||k,before:before[k]??null,after:after[k]??null}));
 const already=current?.payload.plan_id===plan.id;
 return {selection,plan_id:plan.id,model:plan.payload.model_ref.model_id,current_service_id:current?.id||null,already_applied:!!already,current_services:matches.map(s=>({id:s.id,model:s.payload.model_ref.model_id,plan_id:s.payload.plan_id})),differences,request:current&&!already?{kind:'switch',mode:'apply',service_instance_id:current.id,plan_id:plan.id,name:plan.payload.model_ref.model_id+' · 应用推荐配置',goal:'用户选择已有结果的冻结配置，确认新端点切换；来源任务 '+selection.task_id+'，套件 '+selection.recommended.suite_result_id}:null,execution_started:false,notes:['预览不刷新硬件、不停服、不启动服务、不新增测量。','提交后复用原Bittune配置切换流程，重新校验实际状态与审批；端点会改变。']};
}
