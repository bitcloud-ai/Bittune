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
