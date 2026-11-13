import {modelMessage} from "./model-message.ts";
import {validateTaskInput} from "./task-input.ts";
import {SettingsManager as OperatorSettings} from "../core/settings-manager.ts";
import {createApprovalController,createApprovalReviewer,isSecurityMode,SECURITY_LABELS,type SecurityMode} from "../harness/security.ts";
import {runFixedPreparation} from "../workbench/fixed-preparation.ts";
import {buildEvidenceFromResult,submitEvidence,type GenericToolResultEvent} from "../harness/generic-evidence.ts";
import type {TaskScope} from "../harness/task-scope.ts";
import {accountingView} from "./views.ts";
/** Shared local task engine used by the standalone CLI and optional Web adapter.
 * Core remains the authority for managed execution and facts. */
import { switchFrozenPlan } from "../workbench/service-switch.ts";
import { validateTuningBaseline, canReleaseTuningBaseline, bindTuningObjective } from "../workbench/tuning-baseline.ts";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { acceptTaskMessage, createTaskResponder, type TaskMessage } from "../workbench/dialogue.ts";
import { recommendationSchema, recommendationHardware, type RecommendationOutput } from "../workbench/recommendations.ts";
import { exposeWorkbenchTool, retainDeployedService } from "../workbench/plan-schema.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBittuneRuntime, resolveBittunePaths, resolveProductSkillsDir } from "../bittune.ts";
import { CoreClient } from "../harness/core-client.ts";
import { SessionManager } from "../core/session-manager.ts";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";

type JSONValue = Record<string, any>;
interface Task {
  task_id: string;
  security_mode:SecurityMode;
  session_id: string;
  name: string;
  request: JSONValue;
  state: string;
  created_at: string;
  updated_at: string;
  switch_context?: JSONValue;
  currentAction?: JSONValue;
  lifecycleSucceeded?: boolean;
  messages?: TaskMessage[];
  events: JSONValue[];
  records: JSONValue[];
  pending?: JSONValue;
  error?: string;
  summary?: string;
  comparison?: JSONValue;
  recommendations?: RecommendationOutput;
  recommendation_source?: JSONValue;
  manager: SessionManager;
  runtime?: AgentSessionRuntime;
  abort: AbortController;
  approve?: (value: boolean) => void;
}

export async function createTaskEngine() {
// The bundle imports SDK code without invoking the CLI main guard. Children keep normal CLI semantics.
const paths = resolveBittunePaths();
const cwd = process.env.BITTUNE_WORKBENCH_CWD || paths.root;
mkdirSync(cwd, { recursive: true, mode: 0o700 });
mkdirSync(paths.sessions, { recursive: true, mode: 0o700 });
const tasks = new Map<string, Task>();
let active: Task | undefined;
let reading = Promise.resolve<unknown>(undefined);
let stopping = false;
const respond = createTaskResponder(paths.agent, cwd);
const dialogueRequests = new Set<AbortController>();

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function approvalContext(t:Task){return {goal:t.request.goal,kind:t.request.kind,mode:t.request.mode,source_service_id:t.request.service_instance_id,plans:t.records.filter(r=>r.kind==="deployment_plan").map(r=>r.id),candidate_frozen_plan_ids:t.records.filter(r=>r.kind==="deployment_plan"&&r.id!==t.request.plan_id&&r.payload.status==="frozen").map(r=>r.id),services:t.records.filter(r=>r.kind==="service_instance").map(r=>r.id),baseline_complete:canReleaseTuningBaseline(t.records,1+(t.request.max_trials || 0)),workflow:t.request.mode==="tune"?"测量原配置→校验并冻结候选→停止当前受管中间服务→启动冻结候选→同条件测量→比较与报告→保留最后运行时。停止中间服务是提交调优任务已授权的必要切换步骤，不是独立取消服务。":undefined,budget:{requests:t.request.request_count,trials:t.request.max_trials}};}
function confirmTask(t:Task,title:string,message:string,action?:JSONValue):Promise<boolean>{
 if(t.abort.signal.aborted)return Promise.resolve(false);
 t.state="waiting_confirmation";t.pending={confirmation_id:randomUUID(),title,message,action};save(t);
 return new Promise(resolve=>{t.approve=value=>{t.pending=undefined;t.approve=undefined;t.state="running";save(t);resolve(value);};});
}
function view(t: Task): JSONValue {
  return {
    task_id: t.task_id,
    security_mode:t.security_mode,
    session_id: t.session_id,
    name: t.name,
    request: t.request,
    state: t.state,
    created_at: t.created_at,
    updated_at: t.updated_at,
    switch_context: t.switch_context,
    messages: t.messages || [],
    events: t.events,
    records: t.records,
    pending: t.pending,
    error: t.error,
    summary: t.summary,
    comparison: t.comparison,
    recommendations: t.recommendations,
    recommendation_source: t.recommendation_source,
  };
}
function save(t: Task): void {
  t.updated_at = new Date().toISOString();
  t.manager.appendCustomEntry("web_task_state", view(t));
  t.manager.flush();
}
function event(t: Task, type: string, message: string): void {
  const item = {
    type,
    message: message.slice(0, 1400),
    at: new Date().toISOString(),
  };
  t.events.push(item);
  t.events = t.events.slice(-100);
  t.updated_at = item.at;
  t.manager.appendCustomEntry("web_task_event", item);
  t.manager.flush();
}
function reportCoversSuites(t: Task): boolean {
  const suites = t.records
    .filter((r) => r.kind === "suite_result")
    .map((r) => r.id);
  return (
    suites.length > 0 &&
    t.records.some(
      (r) =>
        r.kind === "report" &&
        suites.every((id) =>
          r.payload.coverage?.suites?.some(
            (x: any) => x.suite_result_id === id,
          ),
        ),
    )
  );
}
async function hydrate(): Promise<void> {
  for (const info of await SessionManager.listAll(paths.sessions)) {
    const manager = SessionManager.open(info.path, paths.sessions);
    let saved: any;
    let tail: any[] = [];
    for (const e of manager.getEntries()) {
      if (e.type === "custom" && e.customType === "web_task_state") {
        saved = e.data;
        tail = [];
      }
      if (e.type === "custom" && e.customType === "web_task_event")
        tail.push(e.data);
    }
    if (saved) saved.events = [...saved.events, ...tail].slice(-100);
    if (!saved?.task_id) continue;
    const t: Task = {
      ...saved,
      security_mode:isSecurityMode(saved.security_mode)?saved.security_mode:"manual",
      manager,
      pending: undefined,
      abort: new AbortController(),
    };
    if (["running", "waiting_confirmation", "queued"].includes(t.state)) {
      t.state = "interrupted";
      t.error =
        "任务执行进程已退出；原事实保留，服务状态需重新核对，不自动重放执行。";
    }
    if (
      ["completed", "failed", "interrupted"].includes(t.state) &&
      t.request.kind === "execute" &&
      t.request.mode !== "deploy" &&
      t.records.some((r) => r.kind === "suite_result") &&
      (!reportCoversSuites(t) ||
        (t.request.mode === "tune" &&
          t.records.filter((r) => r.kind === "suite_result").length > 1 &&
          !t.comparison) ||
        (t.request.mode === "tune" &&
          t.records.filter((r) => r.kind === "suite_result").length <
            1 + t.request.max_trials))
    )
      t.state = "partial";
    for (const message of t.messages || []) {
      if (message.state === "pending") {
        message.state = "interrupted";
        message.error = "宿主重启中断了回复；原问题已保留，可重新发送。";
      }
    }
    tasks.set(t.task_id, t);
  }
}
async function coreRead<T>(fn: (c: CoreClient) => Promise<T>, readOnly=false): Promise<T> {
  if (active && !readOnly)
    fail(
      "workspace_busy",
      "工作区正执行任务；请查看该任务的进度，结束后再刷新事实。",
    );
  const job = reading.then(async () => {
    if (active && !readOnly) fail("workspace_busy", "工作区正执行任务。");
    const c = await CoreClient.start({ coreHome: paths.core, readOnly:readOnly && !!active, taskScopeFile:null });
    try {
      return await fn(c);
    } finally {
      await c.stop();
    }
  });
  reading = job.catch(() => undefined);
  return job;
}
function recordResult(t: Task, tool: string, result: any): void {
  const d = result?.details;
  if (result?.isError && !d?.code) {
    const text = result.content
      ?.filter((x: any) => x.type === "text")
      .map((x: any) => x.text)
      .join("\n");
    event(t, "tool_error", `${tool}: ${text || "原生工具调用失败。"}`);
  }
  if (d?.code) event(t, "tool_error", `${tool}: ${d.message || d.code}`);
  if (d?.summary) event(t, "tool_result", d.summary);
  const data = d?.data || {};
  if (tool === "compare_results" && data.comparison)
    t.comparison = { ...data.comparison, run_id: d.run_id };
  for (const [key, kind, id] of [
    ["plan", "deployment_plan", "plan_id"],
    ["correctness_result", "correctness_result", "correctness_result_id"],
    ["service", "service_instance", "service_instance_id"],
    ["benchmark_result", "benchmark_result", "benchmark_result_id"],
    ["suite_result", "suite_result", "suite_result_id"],
    ["experiment", "experiment", "experiment_id"],
    ["report", "report", "report_id"],
  ]) {
    const value = data[key];
    if (value?.[id]) {
      const ref = { kind, id: value[id], payload: value };
      const index = t.records.findIndex(
        (r) => r.kind === kind && r.id === ref.id,
      );
      if (index < 0) t.records.push(ref);
      else t.records[index] = ref;
    }
  }
  for (const a of d?.artifact_refs || [])
    if (!t.records.some((r) => r.id === a.artifact_id))
      t.records.push({ kind: "artifact", id: a.artifact_id, payload: a });
  save(t);
}
async function recommend(t: Task): Promise<void> {
  const p=t.request;
  const c=await CoreClient.start({coreHome:paths.core});
  let snapshot:any;
  try {
    snapshot=(await c.request<any>("inspect_records",{kind:"hardware_snapshot",id:p.hardware_snapshot_id},{sessionId:t.session_id,signal:t.abort.signal})).payload;
  } finally { await c.stop(); }
  if(t.abort.signal.aborted)return;
  t.records.push({kind:"hardware_snapshot",id:snapshot.hardware_snapshot_id,payload:snapshot});
  save(t);
  const taskDir=join(paths.root,"workbench",t.task_id);
  mkdirSync(taskDir,{recursive:true,mode:0o700});
  const scopePath=join(taskDir,"scope.json");
  writeFileSync(scopePath,JSON.stringify({schema_version:1,allow_execution:false,plan_ids:[],service_instance_ids:[],record_ids:[snapshot.hardware_snapshot_id],read_paths:[],preparation_commands:[]}),{mode:0o600});
  const previousScope=process.env.BITTUNE_TASK_SCOPE_FILE;
  process.env.BITTUNE_TASK_SCOPE_FILE=scopePath;
  let runtime:AgentSessionRuntime;
  try { ({runtime}=await createBittuneRuntime({cwd,sessionId:t.session_id,securityMode:t.security_mode,approvalContext:()=>approvalContext(t),onApprovalDecision:(_r,d)=>event(t,"approval_review",`${d.decision}: ${d.reason}`)})); }
  finally {
    if(previousScope===undefined)delete process.env.BITTUNE_TASK_SCOPE_FILE;
    else process.env.BITTUNE_TASK_SCOPE_FILE=previousScope;
  }
  t.runtime=runtime!;
  t.manager=runtime!.session.sessionManager;
  runtime!.session.setActiveToolsByName([]);
  let submitted:RecommendationOutput|undefined;
  runtime!.session.agent.state.tools=[{
    name:"submit_recommendations",label:"提交推荐草稿",
    description:"根据给定真实硬件提交最多三个模型/配置建议。仅保存草稿，不校验、下载、部署或测量。",
    parameters:recommendationSchema,
    execute:async(_id,args)=>{
      submitted=args;
      t.recommendations=args;
      t.recommendation_source={hardware_snapshot_id:snapshot.hardware_snapshot_id,provider:runtime!.session.model?.provider,model:runtime!.session.model?.id,generated_at:new Date().toISOString()};
      save(t);
      return {content:[{type:"text",text:"推荐草稿已保存。"}],details:{draft:true}};
    },
  }];
  let turns=0;
  runtime!.session.agent.shouldStopAfterTurn=()=>!!submitted || ++turns>=3;
  runtime!.session.subscribe(e=>{
    if(e.type==="tool_execution_start")event(t,"tool_start",e.toolName);
    if(e.type==="message_end" && e.message.role==="assistant"){
      if(e.message.stopReason==="error"){t.error=e.message.errorMessage || "API推荐请求失败。";event(t,"model_error",t.error);}
      const text=e.message.content.filter(x=>x.type==="text").map(x=>x.text).join("\n");
      if(text){t.summary=text;event(t,"assistant",text);}
    }
  });
  event(t,"progress","已读取真实硬件快照，正在向当前配置的API模型请求推荐草稿…");
  try {
    await runtime!.session.prompt(
      "本次是只读部署推荐任务，用户已请求推荐，不需要再文字确认。唯一可用工具submit_recommendations必须调用，优先给出1个完整推荐，必要时才给第2、3个。summary和rationale各不超过120个汉字，limitations每条简短。禁止调查文件、调用设备、下载、部署、测量或任何副作用。"+
      "根据GPU型号/总显存与当前空闲、CPU/RAM/OS/CUDA/驱动，以及用户目标选择模型、量化、vLLM或SGLang，给出资源参数与测量预算默认值；区分预计与实测，不能保证未验证的组合可运行。"+
      "优先考虑输入目录和用户指定模型，也可提出目录外公开模型建议。model_id必须是模型仓库ID；无把握则在limitations说明。"+
      "本机model_path和固定image_digest只能原样采用输入候选/用户明确提供的值，不能猜测；缺少时返回空字符串，并说明需要准备制品。不得为新模型套用另一个模型的权重目录。"+
      "保守设置上下文、最大序列数、显存比例；正式调优比较推荐cache_disabled=true关闭前缀复用，区别于生成中的KV缓存；input_tokens+output_tokens必须小于等于max_context。正式请求默认不超过用户预算（未指定时4），max_trials不超过3。"+
      "单机多卡建议显式给出gpu_device_ids和tensor_parallel_size，GPU编号只能来自快照；vLLM还可给pipeline_parallel_size，SGLang的pipeline_parallel_size只能为1。TP乘PP不能超过所选空闲GPU数量；并行规模只是待验证的部署配置，不承诺性能提升。"+
      "每次submit_recommendations必须全量提交summary与完整candidates对象的所有required字段，包括limitations。工具校验失败后也必须重发完整对象，不能只补缺失字段或发送JSON补丁；不要用省略号代替字段。数字必须符合工具schema；输出通过submit_recommendations，rationale解释硬件与配置的对应关系，limitations说明制品/显存估算/兼容性尚未验证。"+
      "\n真实硬件："+JSON.stringify(recommendationHardware(snapshot))+
      "\n用户目标："+p.goal+"；执行模式："+p.mode+
      "\n用户模型提示："+JSON.stringify({model_id:p.model_id || "",model_path:p.model_path || ""})+
      "\n当前预算偏好："+JSON.stringify({input_tokens:p.input_tokens,output_tokens:p.output_tokens,concurrency:p.concurrency,request_count:p.request_count,max_trials:p.max_trials})+
      "\n输入候选目录（仅建议来源，不是本次运行证明）："+JSON.stringify(p.recommendation_catalog || [])
    );
    if(submitted){
      t.summary=submitted.summary;
      if(t.state!=="cancelled")t.state="recommended";
    } else if(t.state!=="cancelled"){
      t.state="blocked";t.error ||= "API没有提交有效推荐草稿，可重试或手动指定模型。";
    }
  } finally {await runtime!.dispose();t.runtime=undefined;}
}
async function prepare(t: Task): Promise<void> {
  const c = await CoreClient.start({ coreHome: paths.core });
  const request = (tool: string, params: any) =>
    c.request<any>(tool, params, {
      sessionId: t.session_id,
      signal: t.abort.signal,
      onProgress: (message) => event(t, "progress", message),
    });
  let finalState = "blocked";
  try {
    const p = t.request;
    const result = await request("plan_deployment", {
      action: "create",
      prior_source: "user_specified",
      goal: p.goal,
      rationale: "用户通过四步工作台明确选择；目录数据不替代本机校验。",
      hardware_snapshot_id: p.hardware_snapshot_id,
      model_ref: {
        schema_version: 1,
        model_id: p.model_id,
        local_path: p.model_path,
        quantization: p.quantization,
      },
      runtime_spec: {
        schema_version: 1,
        runtime_kind: p.runtime_kind,
        ...(p.runtime_major ? { runtime_major: p.runtime_major } : {}),
        image_repository: p.image_repository,
        image_digest: p.image_digest,
      },
      serving_spec: p.serving_spec,
    });
    recordResult(t, "plan_deployment", { details: result });
    const checked = await request("plan_deployment", {
      action: "validate",
      plan_id: result.data.plan.plan_id,
    });
    recordResult(t, "plan_deployment", { details: checked });
    finalState =
      checked.data.validation.state === "valid" ? "prepared" : "blocked";
    t.summary = checked.summary;
  } finally {
    await c.stop();
  }
  if (t.state !== "cancelled") t.state = finalState;
}
async function switchService(t: Task): Promise<void> {
  const c=await CoreClient.start({coreHome:paths.core});let source:any,target:any;
  try{
    source=(await c.request<any>("inspect_records",{kind:"service_instance",id:t.request.service_instance_id},{sessionId:t.session_id})).payload;
    target=(await c.request<any>("inspect_records",{kind:"deployment_plan",id:t.request.plan_id},{sessionId:t.session_id})).payload;
    if(source.ownership!=="managed")fail("invalid_input","只能切换选定的Bittune受管服务。");
    if(target.status!=="frozen" || !isDeepStrictEqual(source.model_ref,target.model_ref) || !isDeepStrictEqual(source.runtime_spec,target.runtime_spec))fail("invalid_input","参数切换只支持同模型、同镜像的已冻结方案；换模型或引擎请创建新部署任务。");
    t.records.push({kind:"service_instance",id:source.service_instance_id,payload:source},{kind:"deployment_plan",id:target.plan_id,payload:target});
    t.switch_context={previous_plan_id:source.plan_id,previous_service_id:source.service_instance_id,selected_plan_id:target.plan_id};save(t);
  }finally{await c.stop();}
  const taskDir=join(paths.root,"workbench",t.task_id);mkdirSync(taskDir,{recursive:true,mode:0o700});const scopePath=join(taskDir,"scope.json");
  writeFileSync(scopePath,JSON.stringify({schema_version:1,allow_execution:true,plan_ids:[...new Set([source.plan_id,target.plan_id])],service_instance_ids:[source.service_instance_id],record_ids:[source.hardware_snapshot_id,target.hardware_snapshot_id].filter(Boolean),read_paths:[],preparation_commands:[],require_idle_gpu:true,max_service_starts:2}),{mode:0o600});
  const previous=process.env.BITTUNE_TASK_SCOPE_FILE;process.env.BITTUNE_TASK_SCOPE_FILE=scopePath;let runtime:AgentSessionRuntime;
  try{({runtime}=await createBittuneRuntime({cwd,sessionId:t.session_id,securityMode:t.security_mode,approvalContext:()=>approvalContext(t),onApprovalDecision:(_r,d)=>event(t,"approval_review",`${d.decision}: ${d.reason}`)}));}
  finally{if(previous===undefined)delete process.env.BITTUNE_TASK_SCOPE_FILE;else process.env.BITTUNE_TASK_SCOPE_FILE=previous;}
  t.runtime=runtime!;
  try{
    await connectExecution(t,runtime!);runtime!.session.setActiveToolsByName(["inspect_environment","inspect_records","inspect_service","plan_deployment","deploy_service"]);
    const invoke=async(name:string,args:JSONValue)=>{
      t.abort.signal.throwIfAborted();
      const tool=runtime!.session.agent.state.tools.find(x=>x.name===name);if(!tool)fail("invalid_input","不支持的受管操作。");
      const id=randomUUID(),params=validateToolArguments(tool!,{type:"toolCall",id,name,arguments:args});
      t.currentAction={tool:name,params};event(t,"managed_call",name+" "+String(args.action || ""));
      const result=await tool!.execute(id,params,t.abort.signal,update=>{const text=update.content.filter(x=>x.type==="text").map(x=>(x as any).text).join("\n");if(text)event(t,"progress",text);});
      t.currentAction=undefined;recordResult(t,name,result);
      const details=result.details as any;
      if(details?.code)fail(details.code,details.message || "用户拒绝该受管操作；未继续切换。");
      if(name==="deploy_service"&&args.action==="start"&&details?.data?.service){t.switch_context!.new_service_id=details.data.service.service_instance_id;t.switch_context!.endpoint=details.data.service.endpoint;save(t);}
      return details;
    };
    const result=await switchFrozenPlan(invoke,source.service_instance_id,target.plan_id,t.request.goal || "用户确认的参数方案切换");
    t.summary="已通过Bittune完成受管切换，新端点："+result.service.endpoint;
    if(t.state!=="cancelled")t.state="completed";
  }catch(error){
    if(!t.abort.signal.aborted){
      const tool=runtime!.session.agent.state.tools.find(x=>x.name==="inspect_records");
      try{const result=await tool!.execute(randomUUID(),{kind:"service_instance",limit:20},t.abort.signal);const data=result.details as any;
        for(const fact of data?.records || []){if(fact.id===source.service_instance_id)continue;if(fact.payload?.ownership==="managed"){t.records.push({kind:"service_instance",id:fact.id,payload:fact.payload});t.switch_context!.new_service_id=fact.id;}}save(t);
      }catch{/* Original failure remains authoritative; service list still exposes Core facts. */}
    }
    throw error;
  }finally{await runtime!.dispose();t.runtime=undefined;t.currentAction=undefined;}
}
async function deliverReport(t: Task): Promise<void> {
  const c = await CoreClient.start({ coreHome: paths.core });
  try {
    const fact = await c.request<any>("inspect_records", { kind: "report", id: t.request.source_report_id }, { sessionId: t.session_id });
    t.records.push({ kind: "report", id: fact.id, payload: fact.payload });
    const result = await c.request<any>("export_deliverable", {
      intent: t.request.mode, report_id: t.request.source_report_id,
    }, { sessionId: t.session_id, signal: t.abort.signal, onProgress: message => event(t, "progress", message) });
    recordResult(t, "export_deliverable", { details: result });
    t.summary = result.summary;
    if (t.state !== "cancelled") t.state = "completed";
  } finally { await c.stop(); }
}
async function qualityTask(t:Task):Promise<void>{
  const c=await CoreClient.start({coreHome:paths.core});
  try{
    const pack=await c.request<any>("correctness_pack_info",{path:t.request.correctness_pack_path || ""},{sessionId:t.session_id,signal:t.abort.signal});
    if(t.request.correctness_pack_hash!==pack.pack_hash)fail("state_conflict","评测包已变化，请重新读取并确认。");
    if(pack.sample_count>t.request.request_count)fail("invalid_input","评测包样例超过本轮明确预算，未发起质量请求。");
    event(t,"progress",`已冻结评测包${pack.pack_id}，共${pack.sample_count}条；使用现有exact/contains规则，不评估通用业务质量。`);
    const result=await c.request<any>("benchmark_suite",{intent:"correctness",service_instance_id:t.request.service_instance_id,correctness_pack_path:pack.path,correctness_pack_hash:pack.pack_hash,correctness_max_samples:t.request.request_count,correctness_output_tokens:t.request.output_tokens},{sessionId:t.session_id,signal:t.abort.signal,onProgress:m=>event(t,"progress",m)});
    recordResult(t,"benchmark_suite",{details:result});
    const score=result.data.correctness_result;
    t.summary=typeof score.accuracy==="number"?`文本规则命中率${(score.accuracy*100).toFixed(1)}%，用户阈值${t.request.quality_threshold}%；只适用于本包。`:result.summary;
    if(t.state!=="cancelled")t.state=score.state==="healthy"?"completed":"blocked";
  }finally{await c.stop();}
}
async function compareSaved(t: Task): Promise<void> {
  const c=await CoreClient.start({coreHome:paths.core});
  try{
    for(const id of new Set(t.request.suite_points.map((p:any)=>p.suite_result_id))){
      const fact=await c.request<any>("inspect_records",{kind:"suite_result",id},{sessionId:t.session_id,signal:t.abort.signal});
      t.records.push({kind:"suite_result",id,payload:fact.payload});
    }
    const result=await c.request<any>("compare_results",{suite_points:t.request.suite_points,objective:t.request.goal,record:true},{sessionId:t.session_id,signal:t.abort.signal});
    recordResult(t,"compare_results",{details:result});t.summary=result.summary;
    if(t.state!=="cancelled")t.state="completed";
  }finally{await c.stop();}
}
async function editReport(t: Task): Promise<void> {
  const c = await CoreClient.start({ coreHome: paths.core });
  try {
    const source = await c.request<any>("inspect_records", {kind:"report", id:t.request.source_report_id}, {sessionId:t.session_id, signal:t.abort.signal});
    t.records.push({kind:"report", id:t.request.source_report_id, payload:source.payload});
    const params: JSONValue = {...t.request.report_text};
    if (t.request.mode === "revise") params.based_on_report_id = t.request.source_report_id;
    else {
      params.extends_report_id = t.request.source_report_id;
      params.experiment_selections = t.request.experiment_ids || [];
      const metrics = [...new Set<string>((source.payload.coverage?.suites || []).flatMap((s:any)=>s.metrics || []))];
      params.suite_selections = t.request.suite_result_ids.map((id:string)=>({suite_result_id:id, metrics:metrics.length ? metrics : ["output_tokens_per_second","mean_ttft_ms"]}));
    }
    event(t,"progress", t.request.mode === "revise" ? "正在保留原引用生成文字修订版本。" : "正在保留原引用并追加已保存套件，生成来源扩展版本。");
    const result = await c.request<any>("write_report", params, {sessionId:t.session_id, signal:t.abort.signal});
    recordResult(t,"write_report",{details:result});
    t.summary=result.summary;
    if(t.state!=="cancelled")t.state="completed";
  } finally { await c.stop(); }
}
async function prepareAssets(t: Task): Promise<void> {
  const model = t.request.mode === "model";
  const imageExport = t.request.mode === "image-export";
  let plan:any, command:string;
  const quote=(value:string)=>"'"+value.replaceAll("'", "'\\''")+"'";
  if(model){
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t.request.model_id))fail("invalid_input","需要明确的模型仓库ID。");
    const source=process.env.BITTUNE_MODEL_SOURCE || "huggingface";
    if(!["huggingface","modelscope"].includes(source))fail("invalid_input","节点模型下载源必须为huggingface或modelscope。");
    command=`sh ${quote(join(resolveProductSkillsDir(),"prepare-model/scripts/prepare-model.sh"))} ${quote(t.request.model_id)}`;
    if(source==="modelscope")command+=" '' 'modelscope'";
    event(t,"progress",`模型准备来源：${source==="modelscope"?"ModelScope 官方 SDK":"Hugging Face CLI"}。`);
  } else if(imageExport) {
    const kind=t.request.runtime_kind,repository=kind==="vllm"?"vllm/vllm-openai":"lmsysorg/sglang";
    command=`sh ${quote(join(resolveProductSkillsDir(),"prepare-engine/scripts/prepare-engine.sh"))} ${kind} ${quote(repository+"@"+t.request.image_digest)} export-oci ${quote(t.request.output_path)}`;
  } else {
    const read=await CoreClient.start({coreHome:paths.core});
    try{const result=await read.request<any>("plan_deployment",{action:"validate",plan_id:t.request.plan_id},{sessionId:t.session_id,signal:t.abort.signal});recordResult(t,"plan_deployment",{details:result});plan=result.data.plan;}
    finally{await read.stop();}
    if(!plan.validation.errors.some((e:any)=>e.code==="image_missing")){t.state=plan.validation.state==="valid"?"completed":"blocked";t.summary="已核对计划；当前没有缺失镜像需要准备。";return;}
    const spec=plan.runtime_spec, repository=spec.runtime_kind==="vllm"?"vllm/vllm-openai":"lmsysorg/sglang";
    if(spec.image_repository!==repository||!/^sha256:[a-f0-9]{64}$/.test(spec.image_digest))fail("invalid_input","现有prepare-engine技能只准备对应官方仓库的固定digest镜像。");
    command=`sh ${quote(join(resolveProductSkillsDir(),"prepare-engine/scripts/prepare-engine.sh"))} ${spec.runtime_kind} ${quote(spec.image_repository+"@"+spec.image_digest)}`;
    if(t.request.oci_path)command+=` import-oci ${quote(t.request.oci_path)}`;
  }
  const taskDir=join(paths.root,"workbench",t.task_id);mkdirSync(taskDir,{recursive:true,mode:0o700});
  const scopePath=join(taskDir,"scope.json");writeFileSync(scopePath,JSON.stringify({schema_version:1,allow_execution:true,plan_ids:plan?[plan.plan_id]:[],service_instance_ids:[],record_ids:plan?[plan.plan_id,plan.hardware_snapshot_id].filter(Boolean):[],read_paths:[],preparation_commands:[command]}),{mode:0o600});
  const preparationCore=await CoreClient.start({coreHome:paths.core,taskScopeFile:scopePath});
  let succeeded=false;
  try{
    const {scope}=await preparationCore.request<{scope:TaskScope}>("task_scope_status",{},{sessionId:t.session_id,signal:t.abort.signal});
    const approve=createApprovalController({mode:()=>t.security_mode,review:createApprovalReviewer(paths.agent,cwd),onDecision:(_r,d)=>event(t,"approval_review",`${d.decision}: ${d.reason}`)});
    let lastProgress=0;
    let result:GenericToolResultEvent|undefined;
    try{
      const value=await runFixedPreparation({command,cwd,scope,protectedRoots:[paths.root,paths.core,paths.agent],signal:t.abort.signal,
        timeoutSeconds:imageExport?21600:3600,
        approve:reason=>approve({title:"制品准备与网络写入",message:reason,tool:"bash",params:{command},context:approvalContext(t),signal:t.abort.signal},()=>confirmTask(t,"制品准备与网络写入",reason,{tool:"bash",params:{command}})),
        onStart:()=>event(t,"tool_start","bash：执行已确认的制品准备技能（不调用模型API）"),
        onUpdate:text=>{if(Date.now()-lastProgress>=2000){lastProgress=Date.now();event(t,"progress",text.slice(-1000));}},
      });
      if(value)result={type:"tool_result",toolCallId:randomUUID(),toolName:"bash",input:{command},...value,isError:false};
    }catch(error){result={type:"tool_result",toolCallId:randomUUID(),toolName:"bash",input:{command},content:[{type:"text",text:(error as Error).message}],details:undefined,isError:true};}
    if(result){
      const receipt=await submitEvidence(buildEvidenceFromResult(result,t.abort.signal.aborted?"cancelled":result.isError?"failed":"completed"),{client:preparationCore,coreHome:paths.core,sessionId:t.session_id,warn:message=>event(t,"evidence_warning",message)});
      if(receipt){t.records.push({kind:"run",id:receipt.run_id,payload:receipt});for(const a of receipt.artifact_refs)t.records.push({kind:"artifact",id:a.artifact_id,payload:a});save(t);}
      const text=result.content.filter(x=>x.type==="text").map(x=>x.text).join("\n");event(t,result.isError?"tool_error":"tool_result",text.slice(-1400));
      succeeded=!result.isError&&!!receipt;
    }
  }finally{await preparationCore.stop();}
  if(t.state==="cancelled")return;
  if(imageExport){t.state=succeeded?"completed":"blocked";t.summary=succeeded?"官方镜像OCI目录已导出并核验；节点导入与模型启动仍需单独完成。":"镜像OCI导出未完成，查看原生工具记录。";return;}
  if(model){t.state=succeeded?"completed":"blocked";t.summary=succeeded?"模型准备脚本已完成；本机路径见技能输出，返回参数页后由Core校验身份。":"模型准备未完成，查看原生工具输出；未启动模型。";return;}
  const verify=await CoreClient.start({coreHome:paths.core});
  try{const result=await verify.request<any>("plan_deployment",{action:"validate",plan_id:plan.plan_id},{sessionId:t.session_id,signal:t.abort.signal});recordResult(t,"plan_deployment",{details:result});t.state=result.data.validation.state==="valid"?"completed":"blocked";t.summary=result.summary;}
  finally{await verify.stop();}
}
function profileDocument(p: any): JSONValue {
  return {
    registry: {
      schema_version: 2,
      profile_id: "web-workbench",
      concurrency_mode: "ladder",
      budget: {
        max_points: 1,
        max_requests: p.request_count,
        max_duration_seconds: 600,
        max_artifact_bytes: 16777216,
      },
      scenarios: [
        {
          scenario_id: "web-point",
          scenario: "chat",
          input_tokens: p.input_tokens,
          output_tokens: p.output_tokens,
          concurrency: [p.concurrency],
          request_count: p.request_count,
          closed_loop: true,
          stream: true,
          ignore_eos: true,
          temperature: 0,
          top_p: 1,
          seed: 42,
          warmup_requests: 1,
          request_timeout_seconds: 180,
        },
      ],
    },
    acceptance: {
      schema_version: 2,
      success_rate_min: 0.99,
      latency_comparison: "raw_ms",
      request_limits_ms: { e2e: 60000, ttft: 30000, tpot: 1000, itl: 1000 },
      p99_limits_ms: { e2e: 60000, ttft: 30000, tpot: 1000, itl: 1000 },
      stop_policy: { throughput_drop_ratio: 0.2 },
    },
  };
}
async function connectExecution(t: Task, runtime: AgentSessionRuntime): Promise<void> {
  t.manager = runtime.session.sessionManager;
  let current: any;
  runtime.session.subscribe((e) => {
    if (e.type === "tool_execution_start") {
      current = { tool: e.toolName, params: e.args };
      event(
        t,
        "tool_start",
        `${e.toolName} ${String((e.args as any)?.action || "")}`,
      );
    }
    if (e.type === "tool_execution_update") {
      const text = (e.partialResult as any)?.content
        ?.filter((x: any) => x.type === "text")
        .map((x: any) => x.text)
        .join("\n");
      if (text) event(t, "progress", text);
    }
    if (e.type === "tool_execution_end") {
      recordResult(t, e.toolName, { ...e.result, isError: e.isError });
      const d=(e.result as any).details, s=d?.data?.service;
      if(e.toolName==="deploy_service"&&!e.isError&&!d?.code&&s) {
        const action=current?.params?.action;
        if(action==="stop"&&s.desired==="stopped" || ["start","recover"].includes(action)&&s.observed_state==="ready")t.lifecycleSucceeded=true;
      }
    }
    if (e.type === "message_end" && e.message.role === "assistant") {
      if (e.message.stopReason === "error") {
        t.error = e.message.errorMessage || "认知模型请求失败。";
        event(t, "model_error", t.error);
      }
      const text = e.message.content
        .filter((x: any) => x.type === "text")
        .map((x: any) => x.text)
        .join("\n");
      if (text) {
        t.summary = text;
        event(t, "assistant", text);
      }
    }
  });
  const ui = runtime.session.extensionRunner.getUIContext();
  await runtime.session.bindExtensions({
    mode: "tui",
    uiContext: {
      ...ui,
      confirm: (title, message) => confirmTask(t,title,message,t.currentAction || current),
    },
  });
}
async function execute(t: Task, continuing = false): Promise<void> {
  const p = t.request;
  const managing = p.kind === "service";
  const reuseBaseline = !managing && p.mode === "tune" && !!p.service_instance_id;
  const count = p.mode === "tune" ? 1 + p.max_trials : 1;
  let reportOnly =
    continuing &&
    t.records.filter((r) => r.kind === "suite_result").length >= count;
  const taskDir = join(paths.root, "workbench", t.task_id);
  mkdirSync(taskDir, { recursive: true, mode: 0o700 });
  const profilePath = join(taskDir, "profile.json");
  if (!managing && p.mode !== "deploy")
    writeFileSync(profilePath, JSON.stringify(profileDocument(p)), {
      mode: 0o600,
    });
  const c = await CoreClient.start({ coreHome: paths.core });
  let plan: any;
  let profile: any;
  let previous: any;
  try {
    if (continuing) {
      previous = await c.request(
        "scope_file_info",
        { path: join(taskDir, "scope.json") },
        { sessionId: t.session_id },
      );
      reportOnly ||=
        previous.usage.suite_calls >= count ||
        previous.usage.points >= count ||
        previous.usage.requests + p.request_count > count * p.request_count;
    }
    if (!managing && !reportOnly && !reuseBaseline) {
      const activity = await c.request<any>(
        "gpu_activity",
        {},
        { sessionId: t.session_id },
      );
      if (activity.data.busy)
        fail(
          "resource_busy",
          "GPU正被现有进程使用；等待资源空闲后再明确重试，不终止其他任务。",
        );
    }
    let planId = p.plan_id;
    if (managing)
      planId = (
        await c.request<any>(
          "inspect_records",
          { kind: "service_instance", id: p.service_instance_id },
          { sessionId: t.session_id },
        )
      ).payload.plan_id;
    plan = (
      await c.request<any>(
        "inspect_records",
        { kind: "deployment_plan", id: planId },
        { sessionId: t.session_id },
      )
    ).payload;
    if(reuseBaseline && (!continuing || !t.records.some(r=>r.kind==="suite_result"))) {
      const source=await c.request<any>("inspect_records",{kind:"service_instance",id:p.service_instance_id},{sessionId:t.session_id});
      validateTuningBaseline(source,plan,p.plan_id);
      const activity=await c.request<any>("gpu_activity",{service_instance_id:p.service_instance_id},{sessionId:t.session_id});
      if(activity.data.other_busy)fail("resource_busy","GPU存在其他任务占用；基准服务保持不动，等待空闲后继续。");
      if(!t.records.some(r=>r.kind==="service_instance"&&r.id===source.id))t.records.push({kind:"service_instance",id:source.id,payload:source.payload});
      if(!t.records.some(r=>r.kind==="deployment_plan"&&r.id===plan.plan_id))t.records.push({kind:"deployment_plan",id:plan.plan_id,payload:plan});
    }

    if (!managing && p.mode !== "deploy")
      profile = await c.request(
        "profile_info",
        { path: profilePath },
        { sessionId: t.session_id },
      );
  } finally {
    await c.stop();
  }
  if (t.abort.signal.aborted) return;
  if (!managing && !reportOnly && plan.validation?.state !== "valid")
    fail("plan_not_attemptable", "选择的计划尚未校验通过。");
  if (!managing && p.mode !== "deploy") {
    const context = Number(
      plan.serving_spec.max_model_len ?? plan.serving_spec.context_length,
    );
    if (!Number.isFinite(context) || p.input_tokens + p.output_tokens > context)
      fail(
        "invalid_input",
        "测量输入与输出Token总数超出已校验计划上下文；未启动模型。",
      );
  }
  const scopePath = join(taskDir, "scope.json");
  writeFileSync(
    scopePath,
    JSON.stringify({
      schema_version: 1,
      allow_execution: !reportOnly,
      plan_ids: managing
        ? []
        : [
            ...new Set([
              plan.plan_id,
              ...(continuing
                ? t.records
                    .filter((r) => r.kind === "deployment_plan")
                    .map((r) => r.id)
                : []),
            ]),
          ],
      ...(managing
        ? {
            tool_actions: {
              deploy_service: [p.mode],
              inspect_service: ["get"],
            },
          }
        : {}),
      service_instance_ids: managing
        ? [p.service_instance_id]
        : continuing
          ? t.records
              .filter((r) => r.kind === "service_instance")
              .map((r) => r.id)
          : reuseBaseline ? [p.service_instance_id] : [],
      record_ids: [
        ...new Set([
          plan.plan_id,
          plan.hardware_snapshot_id,
          ...(reuseBaseline ? [p.service_instance_id] : []),
          ...(continuing ? t.records.map((r) => r.id) : []),
        ]),
      ],
      read_paths: managing || p.mode === "deploy" ? [] : [profilePath],
      preparation_commands: [],
      ...(!managing && !reportOnly
        ? { require_idle_gpu: true, max_service_starts: count }
        : {}),
      ...(!managing && p.mode !== "deploy"
        ? {
            experiment_budget: {
              profile_hash: profile.profile_hash,
              ...(previous
                ? {
                    previous_scope_hashes: [
                      ...new Set([
                        ...previous.previous_scope_hashes,
                        previous.scope_hash,
                      ]),
                    ],
                  }
                : {}),
              max_suite_calls: count,
              max_points: count,
              max_requests: count * p.request_count,
            },
          }
        : {}),
    }),
    { mode: 0o600 },
  );
  const previousScope = process.env.BITTUNE_TASK_SCOPE_FILE;
  process.env.BITTUNE_TASK_SCOPE_FILE = scopePath;
  let runtime: AgentSessionRuntime;
  try {
    ({ runtime } = await createBittuneRuntime({
      cwd,
      sessionId: t.session_id,
      securityMode:t.security_mode,approvalContext:()=>approvalContext(t),onApprovalDecision:(_r,d)=>event(t,"approval_review",`${d.decision}: ${d.reason}`),
    }));
  } finally {
    if (previousScope === undefined) delete process.env.BITTUNE_TASK_SCOPE_FILE;
    else process.env.BITTUNE_TASK_SCOPE_FILE = previousScope;
  }
  t.runtime = runtime!;
  if (t.abort.signal.aborted || t.state === "cancelled") {
    await runtime!.dispose();
    return;
  }
  await connectExecution(t, runtime!);
  runtime!.session.setActiveToolsByName(
    (managing
      ? ["inspect_service", "deploy_service"]
      : p.mode === "deploy"
        ? ["inspect_environment","inspect_service","inspect_records","plan_deployment","deploy_service"]
      : reportOnly
        ? [
            "inspect_records",
            "compare_results",
            "write_report",
            "export_deliverable",
          ]
        : [
            "inspect_environment",
            "inspect_service",
            "inspect_records",
            "plan_deployment",
            "deploy_service",
            "benchmark_suite",
            "compare_results",
            "write_report",
            "export_deliverable",
          ]).filter(name => name !== "compare_results" || count > 1),
  );
  runtime!.session.agent.state.tools =
    runtime!.session.agent.state.tools.map(tool => exposeWorkbenchTool(managing ? tool : retainDeployedService(tool,
      () => !reportOnly && p.mode === "tune" && (reuseBaseline ? canReleaseTuningBaseline(t.records,count) : t.records.filter(r => r.kind === "suite_result").length < count),
    ))).map(tool=>reuseBaseline?bindTuningObjective(tool,p.goal):tool);
  const taskGoal =
    p.mode === "deploy"
      ? "仅部署并记录真实服务端点，不测量；部署成功后必须保持本轮服务运行，停止服务由用户在运行时管理中主动发起，不得在任务收尾时stop。"
      : `使用benchmark_suite(intent=performance_sweep,package=short,profile_path=${JSON.stringify(profilePath)})。仅该冻结档案，最多${count}次Suite、${count}点、${count * p.request_count}正式请求。${p.mode === "tune" ? `基线后最多${p.max_trials}个保守参数候选；不同方案另建继承计划，比较必须保留不可签公平结论等限制；固定沿用原计划的缓存关闭设置，不在候选中改变缓存条件。` : "只跑基线，不搜索参数。"} 仅当还有下一个调优候选需要启动时，才停止当前中间服务释放GPU；仅基线测量或最后一个候选完成后，必须保留当前运行时和真实端点供用户使用，不得为了收尾或生成报告stop。不自动应用或重启所谓最佳方案，用户在运行时管理中自行决定。${count > 1 ? "有两个完整工作点时调用compare_results并record=true；仅Core可签字时才形成Experiment。" : "本任务只有一个工作点，不调用compare_results，不创建Experiment。"}write_report仅引用实际存在的原生Experiment，没有则如实说明，不编造；suite_selections仍覆盖全部点。按真实结果写报告，再用export_deliverable(intent=report_bundle,report_id=新报告ID)一次导出全部工作点、签名PDF和证据。导出仅传intent和report_id，不混入service_instance_id。每点正式请求与1次预热分开记录，Ready/API前置探测另计，不把正式样本数称为全部模型调用数。`;
  const setup = reuseBaseline
    ? `用户选定的运行时${p.service_instance_id}是已运行的基准，配置为计划${p.plan_id}。先inspect_service(action=get)核对这个具体服务，再对它调用benchmark_suite测量基准，不重新freeze/start基准，不把该服务自身的GPU占用当成外部冲突。基准必须完整测量成功后才可派生候选并经原生确认停止基准；基准失败保留当前服务，不继续候选。用户目标指定的比较指标必须用于compare_results。候选阶段只继承此模型和镜像，Core仍检查新服务的GPU空闲条件。继续任务时先读本任务已完成的Suite与服务，不能重跑已有基准。`
    : `先inspect_records读取已校验计划，inspect_environment确认GPU空闲；计划刚经校验，不得仅因快照ID不同而声称过期；只有Core明确报告snapshot_stale才继承创建新草稿；有其他任务占用则报告等待，不启动、不终止他人。不要调用inspect_service(action=list)，本任务只可get本轮创建的具体服务ID。若原快照过期，只继承原计划新建同模型/同镜像draft并引用本次快照。然后按已知计划validate/freeze/start（ready_timeout_seconds=600），只有本轮范围内服务可操作。`;
  const prompt = managing
    ? `只处理用户选定的现有服务${p.service_instance_id}，先inspect_service(action=get)，然后deploy_service(action=${p.mode},service_instance_id=${p.service_instance_id})，保留原生确认；禁止start/创建计划/测量/模型下载，不操作其他服务，中文汇报真实观察状态。`
    : `通过Bittune完成已确认的工作台任务，中文汇报。用户目标：${p.goal || "部署及验证"}\n计划ID=${p.plan_id}。${setup}${taskGoal}\n用户已确认并提交本任务，不要以文字再次要求回复确认。直接调用所需的原生工具，freeze/start/stop等动作由本任务审批策略处理；需人工时会触发确认卡片，代理或完全模式以工具实际返回为准，不能自行批准或用文字代替。用户拒绝立即停止后续副作用。禁止下载镜像/权重，禁止任意shell/文件读取/外部端点，不更换选定模型或镜像。新计划create必须prior_source=user_specified，并用based_on_plan_id继承；serving_spec替换整段，调参时显式保留原来的其余参数；validate/freeze只传action和plan_id。报告引用真实Run、Suite及来源，未知指标不补0、不可签结论不伪造。发生失败不重试GPU，保留失败事实并报告；不要因测量、比较或报告失败而停止已部署运行时，服务交由用户在运行时管理中处理。`;
  let finalState = "blocked";
  try {
    const continuation = continuing
      ? `\n这是同一任务的人工继续，已完成的基线或候选不得重测；若没有已完成套件，先执行原预算内的基线。已完成套件：${t.records
          .filter((r) => r.kind === "suite_result")
          .map((r) => r.id)
          .join(
            ",",
          )}。累计已预留${previous.usage.suite_calls}次Suite/${previous.usage.requests}正式请求，总预算仍为${count}次Suite/${count * p.request_count}请求。本轮只按原用户目标补未完成的基线/候选，从create新草稿开始；新建一份覆盖已有及本轮全部Suite的完整报告，使用suite_selections且不传based_on_report_id；原报告保留。旧报告：${t.records
          .filter((r) => r.kind === "report")
          .map((r) => r.id)
          .join(",")}。`
      : "";
    const reportPrompt = `仅整理本任务既有事实，不允许任何模型启动、参数执行或测量。原目标：${p.goal}。已有Suite：${t.records
      .filter((r) => r.kind === "suite_result")
      .map((r) => r.id)
      .join(",")}；原报告：${t.records
      .filter((r) => r.kind === "report")
      .map((r) => r.id)
      .join(
        ",",
      )}。先inspect_records读取Suite与所需Benchmark事实。${count > 1 ? "有至少两个完整工作点才调用compare_results，保留公平性限制。" : "这里只有一个工作点，不调用compare_results或编造Experiment。"}用write_report新建完整报告，suite_selections覆盖全部既有Suite行，不传based_on_report_id；based_on_report_id只适用于原引用不变的文字修订，不能增加新套件。Core已恢复同一原生会话先前范围内产生的事实/Run/Artifact身份。对新报告调用export_deliverable(intent=report_bundle,report_id=新报告ID)导出全部工作点的完整包，不把旧单套件文件当作完整包；服务ID：${t.records
      .filter((r) => r.kind === "service_instance")
      .map((r) => r.id)
      .join(",")}。全部GPU测量预算已结束，不重跑、不补测，不发布。`;
    await runtime!.session.prompt(
      `本任务审批策略为${SECURITY_LABELS[t.security_mode]}。审批未通过不等于用户拒绝；请按实际代理或人工记录描述，不推断用户表达过拒绝。\n` + (reportOnly ? reportPrompt : prompt + continuation),
    );
    finalState =
      managing || p.mode === "deploy"
          ? t.lifecycleSucceeded
          ? "completed"
          : "blocked"
        : reportCoversSuites(t) &&
            (p.mode !== "tune" ||
              (t.records.filter((r) => r.kind === "suite_result").length >=
                count &&
                (count === 1 || !!t.comparison)))
          ? "completed"
          : t.records.some((r) => r.kind === "suite_result")
            ? "partial"
            : "blocked";
  } finally {
    await runtime!.dispose();
    t.runtime = undefined;
  }
  if (t.state !== "cancelled") t.state = finalState;
}
async function startTask(p: JSONValue): Promise<JSONValue> {
  p={goal:"",...p};

  validateTaskInput(p);
  p={...p,security_mode:isSecurityMode(p.security_mode)?p.security_mode:OperatorSettings.create(cwd,paths.agent,{projectTrusted:false}).getSecurityMode()};
  const existing = tasks.get(p.task_id);
  if (existing) {
    if (!isDeepStrictEqual(existing.request, p))
      fail("conflict", "同一任务请求ID不能绑定不同参数。");
    return view(existing);
  }
  if (active) fail("workspace_busy", "该工作区已有活跃任务；请先完成或取消。");
  const manager = SessionManager.create(cwd, paths.sessions);
  const t: Task = {
    task_id: p.task_id,
    security_mode:p.security_mode,
    session_id: manager.getSessionId(),
    name: p.name,
    request: p,
    state: "queued",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    records: [],
    events: [],
    manager,
    abort: new AbortController(),
  };
  tasks.set(t.task_id, t);
  launch(t);
  return view(t);
}
function launch(t: Task, continuing = false): void {
  const p = t.request;
  t.state = "queued";
  t.abort = new AbortController();
  t.error = undefined;
  t.lifecycleSucceeded = false;
  active = t;
  save(t);
  void (async () => {
    try {
      await reading;
      if (t.abort.signal.aborted) return;
      t.state = "running";
      save(t);
      if (p.kind === "recommend") await recommend(t);

      else if (p.kind === "prepare") await prepare(t);
      else if (p.kind === "report") await editReport(t);
      else if (p.kind === "compare") await compareSaved(t);
      else if (p.kind === "quality") await qualityTask(t);
      else if (p.kind === "delivery") await deliverReport(t);
      else if (p.kind === "switch") await switchService(t);
      else if (p.kind === "assets") await prepareAssets(t);
      else await execute(t, continuing);
    } catch (error) {
      if (t.state !== "cancelled")
        t.state =
          continuing && (error as any)?.code !== "experiment_budget_exhausted"
            ? "partial"
            : ["user_declined","approval_denied"].includes((error as any)?.code) ? "blocked" : ["resource_busy", "core_busy"].includes((error as any)?.code)
              ? "waiting_resource"
              : "failed";
      if(t.state!=="cancelled")t.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (t.approve) t.approve(false);
      active = undefined;
      save(t);
    }
  })();
}
async function dispatch(method: string, params: JSONValue,requestSignal?:AbortSignal): Promise<unknown> {
  if (stopping) fail("unavailable", "任务执行进程正在关闭。");
  if(method==="security")return {mode:OperatorSettings.create(cwd,paths.agent,{projectTrusted:false}).getSecurityMode(),labels:SECURITY_LABELS};
  if(method==="accounting"){
    let suite:any;for(const task of tasks.values()){suite=task.records.find(r=>r.kind==="suite_result"&&r.id===params.suite_result_id);if(suite)break;}
    if(!suite)suite=await coreRead(c=>c.request("inspect_records",{kind:"suite_result",id:params.suite_result_id},{sessionId:"accounting-read"}),true);
    const row=suite.payload.rows.find((r:any)=>r.scenario_id===params.scenario_id&&r.concurrency===Number(params.concurrency)&&(r.repeat||1)===Number(params.repeat ?? 1));
    if(!row)fail("not_found","所选测量记录不存在。");
    return accountingView(row,Number(params.hours ?? 1));
  }
  if(method==="model_api"||method==="model_chat"){
    const fact=await coreRead(c=>c.request<any>("inspect_records",{kind:"service_instance",id:params.service_instance_id},{sessionId:"service-client"}));
    const s=fact.payload;
    if(s.ownership!=="managed"||s.desired==="stopped"||s.observed_state!=="ready")fail("conflict","所选受管模型服务当前不可用。");
    const endpoint=new URL(s.endpoint);if(endpoint.protocol!=="http:"||!["127.0.0.1","localhost","[::1]"].includes(endpoint.hostname)||endpoint.username||endpoint.password)fail("invalid_input","不是有效的受管本机端点。");
    if(method==="model_api")return {service_instance_id:fact.id,base_url:endpoint.origin+"/v1",model:s.model_ref.model_id};
    if(!Array.isArray(params.messages)||params.messages.length>40||!params.messages.length||params.messages.some((m:any)=>!["user","assistant","system"].includes(m.role)||typeof m.content!=="string"||m.content.length>24000)||!Number.isInteger(params.max_tokens)||params.max_tokens<1||params.max_tokens>8192)fail("invalid_input","对话内容或输出预算不合法。");
    const response=await fetch(endpoint.origin+"/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:s.model_ref.model_id,messages:params.messages,max_tokens:params.max_tokens,stream:false}),signal:requestSignal?AbortSignal.any([requestSignal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000),redirect:"error"});
    const result=await response.json() as any;if(!response.ok)fail("model_unavailable",result.error?.message || "模型请求失败。");return {...result,display_message:modelMessage(result.choices?.[0]?.message || {})};
  }
  if (method === "tasks")
    return {
      tasks: [...tasks.values()]
        .map(view)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    };
  if (method === "task") {
    const t = tasks.get(params.task_id);
    if (!t) fail("not_found", "任务不存在。");
    return view(t);
  }
  if (method === "message") {
    const t = tasks.get(params.task_id);
    if (!t) fail("not_found", "任务不存在。");
    const existing = t.messages?.find(m => m.message_id === params.message_id);
    const message = acceptTaskMessage(t, params.message_id, params.text);
    if (existing) return view(t);
    save(t);
    const controller = new AbortController();
    dialogueRequests.add(controller);
    void (async () => {
      try {
        Object.assign(message, await respond(t, AbortSignal.any([controller.signal, AbortSignal.timeout(100000)])));
        message.state = "answered";
      } catch {
        message.state = stopping ? "interrupted" : "failed";
        message.error = stopping ? "宿主已关闭，原问题保留，可重新发送。" : "智能体回复未完成，请重新发送；任务执行不受影响。";
      } finally {
        dialogueRequests.delete(controller);
        save(t);
      }
    })();
    return view(t);
  }
  if(method==="quality_pack")return coreRead(c=>c.request("correctness_pack_info",params,{sessionId:"web-quality-pack"}),true);
  if(method==="cost_projection")return coreRead(async c=>{
    const suite=(await c.request<any>("inspect_records",{kind:"suite_result",id:params.suite_result_id},{sessionId:"web-cost-read"})).payload;
    return c.request("benchmark_suite",{...params,intent:"cost_planning",service_instance_id:suite.service_instance_id},{sessionId:"web-cost-"+randomUUID()});
  });
  if (method === "create") return startTask(params);
  if (method === "continue") {
    const t = tasks.get(params.task_id);
    if (!t) fail("not_found", "任务不存在。");
    const unstarted =
      t.state === "blocked" &&
      !t.records.some((r) =>
        ["suite_result", "benchmark_result"].includes(r.kind) || (r.kind==="service_instance"&&r.id!==t.request.service_instance_id),
      );
    if (
      active ||
      (!unstarted && !["partial","interrupted"].includes(t.state)) ||
      t.request.kind !== "execute" ||
      !["benchmark", "tune"].includes(t.request.mode)
    )
      fail("conflict", "当前任务不能继续，请核对状态与剩余预算。");
    if(params.security_mode!==undefined){if(!isSecurityMode(params.security_mode))fail("invalid_input","审批策略无效。");event(t,"operator_policy",`用户将继续任务审批改为${SECURITY_LABELS[params.security_mode]}`);t.security_mode=params.security_mode;t.request.security_mode=params.security_mode;}
    launch(t, existsSync(join(paths.root,"workbench",t.task_id,"scope.json")));
    return view(t);
  }
  if (method === "confirm" || method === "cancel") {
    const t = tasks.get(params.task_id);
    if (!t) fail("not_found", "任务不存在。");
    if (method === "confirm") {
      if (!t.approve || t.pending?.confirmation_id !== params.confirmation_id)
        fail("conflict", "该确认已失效，请刷新当前任务。");
      t.approve(params.approved === true);
    } else if (t === active) {
      t.state = "cancelled";
      t.abort.abort();
      t.approve?.(false);
      t.state = "cancelled";
      await t.runtime?.session.abort();
      save(t);
    }
    return view(t);
  }
  if (method === "inspect")
    return coreRead((c) =>
      c.request(
        "inspect_environment",
        {},
        { sessionId: "web-inspect-" + randomUUID() },
      ),
    );
  if (method === "records")
    return coreRead((c) =>
      c.request("inspect_records", params, { sessionId: "web-read" }),true,
    );
  if (method === "artifact")
    return coreRead((c) =>
      c.request(
        "artifact_content",
        { artifact_id: params.artifact_id },
        { sessionId: "web-read" },
      ),true,
    );
  fail("invalid_input", "未知工作台操作。");
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const controller of dialogueRequests) controller.abort();
  if (active) {
    active.state = "interrupted";
    active.approve?.(false);
    await active.runtime?.session.abort();
  }
}

await hydrate();
return {dispatch,shutdown,isActive:()=>!!active||dialogueRequests.size>0};
}
