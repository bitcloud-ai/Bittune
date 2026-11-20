/** Explicit operator workflow over the existing managed tools; no executor or model loop. */
export type ManagedCall = (tool: "inspect_environment"|"inspect_service"|"plan_deployment"|"deploy_service", params: Record<string,unknown>) => Promise<any>;

export async function switchFrozenPlan(call: ManagedCall, sourceId: string, targetPlanId: string, goal: string) {
  const hardware=(await call("inspect_environment",{})).data.hardware_snapshot;
  const created=await call("plan_deployment",{action:"create",prior_source:"user_specified",based_on_plan_id:targetPlanId,hardware_snapshot_id:hardware.hardware_snapshot_id,goal});
  const planId=created.data.plan.plan_id;
  const validation=await call("plan_deployment",{action:"validate",plan_id:planId});
  if(validation.data.validation.state!=="valid")throw Object.assign(new Error("目标方案校验未通过；旧服务未停止。"),{code:"plan_not_attemptable"});
  await call("plan_deployment",{action:"freeze",plan_id:planId});
  const observation=await call("inspect_service",{action:"get",service_instance_id:sourceId});
  const state=observation.data.current_container_state;
  if(!state || state.status==="docker_inspect_failed")throw new Error("无法确认原服务容器状态，未切换服务。");
  if(state.running || !["exited","dead","no_container","stopped"].includes(state.status)){
    const stopped=(await call("deploy_service",{action:"stop",service_instance_id:sourceId})).data.service;
    if(!["exited","dead","stopped"].includes(stopped.observed_state))throw new Error("原服务尚未确认停止，未启动新服务。");
  }
  // The existing Core start replays readiness checks and the scope's idle-GPU requirement.
  const started=await call("deploy_service",{action:"start",plan_id:planId,ready_timeout_seconds:600});
  return {plan:created.data.plan,service:started.data.service};
}

/** Explicit opt-in recovery; only the original service and this attempt's returned service are touched. */
export async function applyFrozenPlanWithRecovery(call:ManagedCall,sourceId:string,targetPlanId:string,originalPlanId:string,goal:string,options:{enabled:boolean;cancelled:()=>boolean;onRecovery?:()=>void}){
 let sourceStopped=false,startAttempted=false;
 const tracked:ManagedCall=async(name,args)=>{if(name==='deploy_service'&&args.action==='start')startAttempted=true;const result=await call(name,args);if(name==='deploy_service'&&args.action==='stop'&&args.service_instance_id===sourceId&&['exited','dead','stopped'].includes(result.data?.service?.observed_state))sourceStopped=true;return result;};
 try{return {applied:true,recovered:false,result:await switchFrozenPlan(tracked,sourceId,targetPlanId,goal)};}
 catch(error){
  const code=(error as any)?.code;
  if(!options.enabled||!sourceStopped||!startAttempted||options.cancelled()||['user_declined','approval_denied'].includes(code))throw error;
  options.onRecovery?.();
  try{
   const failedId=(error as any)?.failed_service_id;
   if(failedId){const observation=await call('inspect_service',{action:'get',service_instance_id:failedId});const state=observation.data?.current_container_state;if(!state||state.status==='docker_inspect_failed')throw Error('不能确认新配置的失败服务状态，未执行自动恢复。');if(state.running||!['exited','dead','no_container','stopped'].includes(state.status))await call('deploy_service',{action:'stop',service_instance_id:failedId});}
   const restored=await switchFrozenPlan(call,sourceId,originalPlanId,goal+'；按用户勾选策略恢复原冻结方案');
   return {applied:false,recovered:true,result:restored,original_error:error instanceof Error?error.message:String(error)};
  }catch(recovery){throw Object.assign(Error('新配置启动失败，恢复原方案也未完成；原始执行记录保留。'),{code:'rollback_failed',cause:error,recovery_error:recovery instanceof Error?recovery.message:String(recovery)});}
 }
}
