import {readFile,writeFile} from "node:fs/promises";
import {resolve,join,sep} from "node:path";
import {randomUUID} from "node:crypto";
import {createInterface} from "node:readline/promises";
import {stripVTControlCharacters} from "node:util";
import {TaskClient} from "../workflows/task-client.ts";
import {resolveBittunePaths} from "../core/bittune-paths.ts";
import {SettingsManager} from "../core/settings-manager.ts";
import {SECURITY_LABELS,isSecurityMode,type SecurityMode} from "../harness/security.ts";

const states:Record<string,string>={queued:"已排队",running:"执行中",waiting_confirmation:"等待确认",completed:"已完成",prepared:"计划已校验",recommended:"推荐已生成",failed:"失败",blocked:"执行受阻",partial:"部分完成",cancelled:"已取消",interrupted:"已中断"};
const flags=new Set(["json","detach","yes","overwrite"]);
const options=new Set(["approval","file","service","plan","task","report","suite","scenario","concurrency","repeat","price","gpus","currency","hours","input-tokens","output-tokens","requests","trials","goal","name","pack","threshold","message","output","confirmation"]);
function parse(args:string[]){const position:string[]=[],values=new Map<string,string>();for(let i=0;i<args.length;i++){const a=args[i]!;if(!a.startsWith("--")){position.push(a);continue;}const k=a.slice(2);if(!options.has(k)&&!flags.has(k))throw new Error(`未知参数${a}`);if(values.has(k))throw new Error(`参数${a}重复`);if(flags.has(k)){values.set(k,"true");continue;}const v=args[++i];if(v===undefined||v.startsWith("--"))throw new Error(`参数${a}缺少值`);values.set(k,v);}return {position,values};}
async function jsonFile(path:string|undefined){if(!path)throw new Error("需要--file指定JSON文件。");let text:string;try{text=await readFile(path,"utf8");}catch{throw new Error("无法读取指定文件。");}try{return JSON.parse(text);}catch{throw new Error("文件不是有效的JSON。");}}
function clean(value:unknown){return stripVTControlCharacters(String(value ?? ""));}
export const WORKFLOW_HELP=`本地任务与服务（独立命令行）
  bittune security [manual|agent|full]          查看/设置手动、代理、完全审批
  bittune task list | show <id>                查看后台任务
  bittune task start --file request.json       发起部署/准备/推荐等任务
  bittune task continue <id> [--approval MODE]  从保存状态继续
  bittune task cancel <id>                     取消任务，服务不会因此自动停掉
  bittune task approve <id> --confirmation ID  批准当前确认（--yes）或拒绝
  bittune task worker status | stop            查看或停止空闲任务进程
  bittune runtime list | show <id> | api <id>
  bittune runtime stop <id> | recover <id>
  bittune runtime apply <id> --plan PLAN        应用冻结配置
  bittune runtime rollback <id> --plan PLAN     回滚指定冻结配置
  bittune runtime chat <id> [--message TEXT]    与部署模型对话，非工程Agent
  bittune tune --service ID [--goal throughput|latency] [--requests 4] [--trials 1]
  bittune accept quality --service ID [--pack PATH] [--requests 5] [--threshold 80]
  bittune accept output --task ID [--hours 1]   实际统计与输出折算
  bittune accept cost --suite ID --scenario NAME --price N [--gpus 1]
  bittune accept summary --task ID             汇总任务、结果与报告入口
  bittune report list | show <id> | export <id> [--output FILE]
  bittune report revise <id> --file text.json
  bittune report extend <id> --file text-and-sources.json
  bittune compare --file points.json [--goal mean_ttft_ms]
通用参数：--json（结构化输出）、--detach（后台执行）、--approval MODE（本次任务审批）。
关闭终端不取消已提交任务；有待人工确认时，可从task approve继续。
`;

export async function runWorkflowCli(command:string,args:string[]){
 if(args.includes("--help")||args.includes("-h")||command==="workflow-help"){console.log(WORKFLOW_HELP);return;}
 const {position,values:v}=parse(args),json=v.has("json");
 const need=(key:string,fallback?:string)=>{const value=v.get(key)||fallback;if(!value)throw new Error(`缺少${key}，可查看bittune ${command} --help。`);return value;};
 const num=(key:string,fallback:number)=>{const n=v.has(key)?Number(v.get(key)):fallback;if(!Number.isFinite(n))throw new Error(`参数--${key}需要有效数值。`);return n;};
 const p=resolveBittunePaths(),settings=SettingsManager.create(process.cwd(),p.agent,{projectTrusted:false});
 const requested=v.get("approval");if(requested&&!isSecurityMode(requested))throw new Error("审批策略必须为manual、agent或full。");
 const mode=(requested || settings.getSecurityMode()) as SecurityMode;
 if(command==="security"){
  const selected=position[0]==="set"?position[1]:position[0];if(selected){if(!isSecurityMode(selected))throw new Error("审批策略必须为manual、agent或full。");settings.setSecurityMode(selected);await settings.flush();}
  const current=settings.getSecurityMode();console.log(json?JSON.stringify({mode:current,label:SECURITY_LABELS[current]}):`新任务审批策略：${SECURITY_LABELS[current]}（${current}）`);return;
 }
 const sub=position[0]||"list",subject=v.get("service")||v.get("task")||v.get("report")||position[1];
 const client=await TaskClient.connect(!(command==="task"&&sub==="worker"),!(command==="task"&&sub==="worker"));
 const disconnect=()=>{client.close();if(!json)console.error("界面已断开，已提交任务保留并在后台继续。");process.exit(130);};
 process.once("SIGINT",disconnect);process.once("SIGTERM",disconnect);
 const emit=(value:any,human?:string)=>console.log(json?JSON.stringify(value):clean(human ?? JSON.stringify(value,null,2)));
 const show=(t:any)=>emit(t,`${t.name}\n任务编号：${t.task_id}\n状态：${states[t.state] || t.state}\n审批：${SECURITY_LABELS[t.security_mode as SecurityMode] || t.security_mode}\n${t.summary || t.error || ""}${t.pending?"\n待确认："+t.pending.title+"\n"+t.pending.message:""}`);
 async function watch(id:string){let last="",prompted="";for(;;){const t=await client.request("task",{task_id:id});if(!json&&last!==t.updated_at){const message=t.events?.at(-1)?.message || states[t.state];if(message)console.error(clean(message));last=t.updated_at;}
   if(t.pending&&t.pending.confirmation_id!==prompted){if(!process.stdin.isTTY||json){show(t);process.exitCode=2;return t;}prompted=t.pending.confirmation_id;const rl=createInterface({input:process.stdin,output:process.stdout});try{const answer=await rl.question(clean(t.pending.title+"\n"+t.pending.message)+"\n批准？[y/N] ");await client.request("confirm",{task_id:id,confirmation_id:t.pending.confirmation_id,approved:/^(y|yes)$/i.test(answer.trim())});}finally{rl.close();}}
   if(!["queued","running","waiting_confirmation"].includes(t.state)){show(t);if(["failed","blocked","interrupted"].includes(t.state))process.exitCode=1;return t;}await new Promise(r=>setTimeout(r,700));
  }}
 async function submit(body:Record<string,any>){const t=await client.request("create",{...body,task_id:body.task_id || randomUUID(),security_mode:body.security_mode || mode});if(v.has("detach")){show(t);return t;}return watch(t.task_id);}
 async function saveArtifact(id:string){const a=await client.request("artifact",{artifact_id:id});const ext:Record<string,string>={"application/zip":"zip","application/pdf":"pdf","text/markdown":"md","application/json":"json"};const output=resolve(v.get("output") || `${id}.${ext[a.media_type] || "bin"}`);
  for(const root of [p.core,p.agent])if(output===resolve(root)||output.startsWith(resolve(root)+sep))throw new Error("导出文件不能覆盖受管存储或配置，请选择其他目录。");
  await writeFile(output,Buffer.from(a.data_base64,"base64"),{flag:v.has("overwrite")?"w":"wx"});emit({output,artifact_id:id},`已保存：${output}`);
 }
 try{
  if(command==="task"){
   if(sub==="worker"){emit(await client.request(position[1]==="stop"?"engine_shutdown":"engine_status"));return;}
   if(sub==="list"){const d=await client.request("tasks");emit(d,d.tasks.map((t:any)=>`${t.task_id}  ${states[t.state] || t.state}  ${t.name}`).join("\n")||"暂无任务。");return;}
   if(sub==="show"){show(await client.request("task",{task_id:need("task",subject)}));return;}
   if(sub==="start"){await submit(await jsonFile(v.get("file")));return;}
   if(sub==="continue"){const id=need("task",subject);const t=await client.request("continue",{task_id:id,...(requested?{security_mode:requested}:{})});if(v.has("detach"))show(t);else await watch(id);return;}
   if(sub==="cancel"){show(await client.request("cancel",{task_id:need("task",subject)}));return;}
   if(sub==="approve"){show(await client.request("confirm",{task_id:need("task",subject),confirmation_id:need("confirmation"),approved:v.has("yes")}));return;}
  }
  if(command==="runtime"){
   if(sub==="list"||sub==="show"){const d=await client.request("records",{kind:"service_instance",...(sub==="show"?{id:need("service",subject)}:{limit:50})});const records=d.records || [d];emit(d,records.map((r:any)=>`${r.id}  ${r.payload.model_ref?.model_id}  ${r.payload.desired}/${r.payload.observed_state}  ${r.payload.endpoint || "未就绪"}`).join("\n"));return;}
   const id=need("service",subject);
   if(sub==="api"){const d=await client.request("model_api",{service_instance_id:id});emit(d,`本机OpenAI兼容API：${d.base_url}\n模型：${d.model}\n此地址供当前主机访问；对外网关为独立可选入口。`);return;}
   if(sub==="chat"){const meta=await client.request("model_api",{service_instance_id:id});const messages:{role:string;content:string}[]=[];let text=v.get("message");let rl:ReturnType<typeof createInterface>|undefined;
    if(!text){if(!process.stdin.isTTY)throw new Error("非交互模式请提供--message。");rl=createInterface({input:process.stdin,output:process.stdout});console.error(`部署模型：${meta.model}；输入/exit退出。`);}
    try{do{if(!text)text=await rl!.question("你 > ");if(text.trim()==="/exit")break;if(!text.trim()){text=undefined;continue;}messages.push({role:"user",content:text});const d=await client.request("model_chat",{service_instance_id:id,messages:messages.slice(-40),max_tokens:num("output-tokens",2048)});const answer=d.display_message?.content || d.choices?.[0]?.message?.content || "模型未给出最终文本，请增加输出预算。";emit(d,answer);messages.push({role:"assistant",content:answer});text=undefined;}while(rl);}finally{rl?.close();}return;}
   if(["stop","recover"].includes(sub)){await submit({kind:"service",name:sub==="stop"?"停止模型服务":"核对并恢复模型服务",goal:"只管理选定的受管服务",service_instance_id:id,mode:sub});return;}
   if(["apply","rollback"].includes(sub)){await submit({kind:"switch",name:sub==="apply"?"应用运行参数":"回滚运行参数",goal:"用户选择新端点切换，沿用原生确认",service_instance_id:id,plan_id:need("plan"),mode:sub});return;}
  }
  if(command==="tune"){
   const id=need("service",position[0]),s=await client.request("records",{kind:"service_instance",id});const goal=v.get("goal") || "throughput";if(!["throughput","latency"].includes(goal))throw new Error("调优目标为throughput或latency。");
   await submit({kind:"execute",mode:"tune",service_instance_id:id,plan_id:s.payload.plan_id,name:v.get("name") || `${s.payload.model_ref.model_id.split("/").at(-1)} · ${goal==="latency"?"响应速度":"吞吐"}调优`,goal:goal==="latency"?"mean_ttft_ms":"output_tokens_per_second",input_tokens:num("input-tokens",128),output_tokens:num("output-tokens",32),concurrency:num("concurrency",1),request_count:num("requests",4),max_trials:num("trials",1)});return;
  }
  if(command==="accept"){
   if(sub==="quality"){const pack=await client.request("quality_pack",{path:v.get("pack") || ""});await submit({kind:"quality",name:"文本问答规则评测",goal:"按指定规则和预算评测选定模型，结束后保留服务",service_instance_id:need("service"),correctness_pack_path:pack.path,correctness_pack_hash:pack.pack_hash,request_count:num("requests",pack.sample_count),output_tokens:num("output-tokens",1024),quality_threshold:num("threshold",80)});return;}
   if(sub==="cost"){const d=await client.request("cost_projection",{suite_result_id:need("suite"),scenario_id:need("scenario"),concurrency:num("concurrency",1),repeat:num("repeat",1),gpu_hourly_price:num("price",Number(need("price"))),gpu_count:num("gpus",1),currency:v.get("currency") || "CNY"});const c=d.data.cost_projection;emit(d,`${c.cost_per_million_output_tokens.toFixed(4)} ${c.inputs.currency}/百万输出Token（按用户费率估算，非实际账单）`);if(v.has("output"))await saveArtifact(d.artifact_refs[0].artifact_id);return;}
   const t=await client.request("task",{task_id:need("task",subject)});
   if(sub==="summary"){emit(t,`${t.name}\n状态：${states[t.state]}\n${t.records.map((r:any)=>`${r.kind}: ${r.id}${r.payload.title?" · "+r.payload.title:""}`).join("\n")}`);return;}
   if(sub==="output"){const rows=[];for(const suite of t.records.filter((r:any)=>r.kind==="suite_result"))for(const row of suite.payload.rows || [])rows.push({suite_result_id:suite.id,scenario_id:row.scenario_id,concurrency:row.concurrency,repeat:row.repeat || 1,...await client.request("accounting",{suite_result_id:suite.id,scenario_id:row.scenario_id,concurrency:row.concurrency,repeat:row.repeat || 1,hours:num("hours",1)})});emit({task_id:t.task_id,rows},rows.map(r=>`${r.suite_result_id} 并发${r.concurrency}\n实际输入/输出Token：${r.observed.input_tokens_total ?? "未记录"}/${r.observed.output_tokens_total ?? "未记录"}\n输出速度：${r.observed.output_tokens_per_second ?? "未记录"} Token/秒\n${r.estimated.hours}小时输出折算：${r.estimated.output_tokens===null?"不可估算":Math.round(r.estimated.output_tokens)+" Token（估算）"}`).join("\n\n"));return;}
  }
  if(command==="report"){
   if(sub==="list"){const d=await client.request("records",{kind:"report",limit:50});emit(d,d.records.map((r:any)=>`${r.id}  ${r.payload.title}`).join("\n"));return;}
   const id=need("report",subject),r=await client.request("records",{kind:"report",id});
   if(sub==="show"){emit(r,`${r.payload.title}\n\n结论\n${r.payload.conclusion}\n\n范围\n${r.payload.scope}\n\n说明\n${r.payload.narrative}`);return;}
   if(sub==="export"){const t=await submit({kind:"delivery",mode:"report_bundle",name:"完整报告导出",goal:"导出既有报告及其来源，不新增测量",source_report_id:id});if(t.state==="completed"&&v.has("output")){const a=t.records.find((f:any)=>f.kind==="artifact"&&f.payload.label==="report-bundle");if(a)await saveArtifact(a.id);}return;}
   if(sub==="revise"||sub==="extend"){const data=await jsonFile(v.get("file"));await submit({kind:"report",mode:sub,name:(`${r.payload.title} · 新版本`).slice(0,120),goal:"保留既有报告与真实来源，创建新版本",source_report_id:id,report_text:data.report_text || data,suite_result_ids:data.suite_result_ids || [],experiment_ids:data.experiment_ids || []});return;}
  }
  if(command==="compare"){const points=await jsonFile(v.get("file"));await submit({kind:"compare",name:"已保存结果比较",goal:v.get("goal") || "output_tokens_per_second",suite_points:Array.isArray(points)?points:points.suite_points});return;}
  throw new Error("未知操作，请查看bittune "+command+" --help。");
 }finally{process.removeListener("SIGINT",disconnect);process.removeListener("SIGTERM",disconnect);client.close();}
}
