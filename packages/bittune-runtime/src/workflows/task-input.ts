const id=(kind:string,v:unknown)=>typeof v==="string"&&new RegExp(`^${kind}-[a-f0-9-]{36}$`,"i").test(v);
const integer=(v:unknown,min:number,max:number)=>typeof v==="number"&&Number.isInteger(v)&&v>=min&&v<=max;
export function validateTaskInput(p:Record<string,any>){
 const fail=(message:string):never=>{throw Object.assign(new Error(message),{code:"invalid_input"});};
 if(!/^[a-f0-9-]{36}$/i.test(p.task_id)||typeof p.name!=="string"||!p.name.trim()||p.name.length>120||typeof p.goal!=="string"||p.goal.length>4000)fail("任务需要有效编号、名称及目标。");
 if(!["recommend","prepare","execute","service","report","assets","compare","switch","quality","delivery"].includes(p.kind))fail("任务类型无效。");
 if(p.security_mode!==undefined&&!["manual","agent","full"].includes(p.security_mode))fail("审批策略无效。");
 if(p.kind==="execute"||p.kind==="prepare"||p.kind==="recommend"){
  if(!["deploy","benchmark","tune"].includes(p.mode))fail("执行范围无效。");
  if(p.mode!=="deploy"&&(!integer(p.input_tokens,1,1048576)||!integer(p.output_tokens,1,1048576)||p.input_tokens+p.output_tokens>1048576||!integer(p.request_count,1,64)||!integer(p.concurrency,1,16)||!integer(p.max_trials,0,3)))fail("Token、请求或候选预算无效。");
  if(p.kind==="execute"&&!id("plan",p.plan_id))fail("执行需要已校验计划编号。");
  if(p.service_instance_id!==undefined&&!id("service",p.service_instance_id))fail("服务编号无效。");
 }
 if(["service","switch","quality"].includes(p.kind)&&!id("service",p.service_instance_id))fail("需要有效的受管服务编号。");
 if(p.kind==="service"&&!["stop","recover"].includes(p.mode))fail("服务动作无效。");
 if(p.kind==="switch"&&(!id("plan",p.plan_id)||!["apply","rollback"].includes(p.mode)))fail("切换需要冻结计划及应用/回滚方式。");
 if(p.kind==="quality"&&(!integer(p.request_count,1,64)||!integer(p.output_tokens,1,8192)||typeof p.quality_threshold!=="number"||p.quality_threshold<1||p.quality_threshold>100||!/^sha256:[a-f0-9]{64}$/.test(p.correctness_pack_hash)))fail("质量包或评测预算无效。");
 if(["report","delivery"].includes(p.kind)&&!id("report",p.source_report_id))fail("需要有效的来源报告编号。");
 if(p.kind==="delivery"&&!["report_bundle","signed_pdf"].includes(p.mode))fail("报告导出方式无效。");
 if(p.kind==="report"&&(!["revise","extend"].includes(p.mode)||!p.report_text||Array.isArray(p.report_text)||Object.entries(p.report_text).some(([k,v])=>!["title","scope","narrative","conclusion"].includes(k)||typeof v!=="string"||v.length>12000)))fail("报告修改字段无效。");
 if(p.kind==="report"&&p.mode==="extend"&&(!Array.isArray(p.suite_result_ids)||p.suite_result_ids.some((v:unknown)=>!id("suite",v))))fail("补充来源需要套件编号列表。");
 if(p.kind==="compare"&&(!["output_tokens_per_second","mean_ttft_ms","goodput_req_per_s"].includes(p.goal)||!Array.isArray(p.suite_points)||p.suite_points.length<2||p.suite_points.length>8||p.suite_points.some((v:any)=>!id("suite",v.suite_result_id)||typeof v.scenario_id!=="string"||!integer(v.concurrency,1,100000))))fail("比较来源或指标无效。");
 if(p.kind==="assets"&&!["model","image","image-export"].includes(p.mode))fail("制品准备方式无效。");
 if(p.kind==="assets"&&p.mode==="image"&&p.oci_path!==undefined&&(typeof p.oci_path!=="string"||!p.oci_path.startsWith("/")))fail("离线镜像需要绝对OCI目录。");
 if(p.kind==="assets"&&p.mode==="image-export"&&(!["vllm","sglang"].includes(p.runtime_kind)||!/^sha256:[a-f0-9]{64}$/.test(p.image_digest)||typeof p.output_path!=="string"||!p.output_path.trim()))fail("镜像导出需要引擎、固定摘要和输出目录。");
}
