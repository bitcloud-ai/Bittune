type Fact={kind?:string;id:string;payload:Record<string,any>};
import type {AgentTool} from "@earendil-works/pi-agent-core";

export function bindTuningObjective(tool:AgentTool,objective:string):AgentTool {
  if(tool.name!=="compare_results"||!["output_tokens_per_second","mean_ttft_ms"].includes(objective))return tool;
  return {...tool,prepareArguments(args){const selected={...(args as Record<string,unknown>),objective};return tool.prepareArguments?tool.prepareArguments(selected):selected;}};
}

/** The operator chooses an existing instance, not an arbitrary endpoint or plan. */
export function validateTuningBaseline(service:Fact,plan:Record<string,any>,planId:string) {
  const s=service.payload;
  if(s.ownership!=="managed"||s.desired==="stopped"||s.observed_state!=="ready")throw new Error("所选模型服务当前不可用，请刷新后重新选择。");
  if(s.plan_id!==planId||plan.plan_id!==planId||plan.status!=="frozen"||plan.validation?.state!=="valid")throw new Error("调优必须使用所选运行时自己的已冻结配置。");
}

export function canReleaseTuningBaseline(records:Fact[],pointLimit:number) {
  const suites=records.filter(r=>r.kind==="suite_result");
  return suites.length>0&&suites.length<pointLimit&&suites[0].payload.rows?.length>0&&suites[0].payload.rows.every((r:any)=>r.measurement_status==="complete");
}
