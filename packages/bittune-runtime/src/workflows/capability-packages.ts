import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateTaskInput} from './task-input.ts';
import {MANAGED_TOOL_NAMES} from '../harness/managed-tools.ts';
type Package={package_id:string;manifest:any;content_hash:string;state:'draft'|'preflighted'|'approved'|'retired';created_at:string;history:{action:string;actor_ref:string;at:string}[]};
const taskFields=new Set(['kind','name','goal','mode','model_id','model_path','quantization','runtime_kind','runtime_major','image_repository','image_digest','serving_spec','snapshot_id','plan_id','service_instance_id','input_tokens','output_tokens','concurrency','request_count','max_trials','correctness_pack_hash','correctness_pack_path','quality_threshold','source_report_id','report_ids','report_text','suite_result_ids','suite_points','experiment_ids','oci_path','output_path']);
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fail(message:string):never{throw Object.assign(Error(message),{code:'invalid_input'});}
export function packageManifest(input:unknown,skills:string[]){
 if(!object(input)||JSON.stringify(input).length>60000)fail('注册包必须是60 KB以内的JSON声明。');
 const p=structuredClone(input);if(Object.keys(p).some(k=>!['schema_version','name','version','description','required_tools','required_skills','task_template'].includes(k))||p.schema_version!=='bittune-capability-package-v1'||typeof p.name!=='string'||!p.name.trim()||p.name.length>120||typeof p.version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(p.version)||typeof p.description!=='string'||p.description.length>2000||!object(p.task_template))fail('注册包名称、版本、说明或声明字段无效。');
 for(const [key,allowed] of [['required_tools',[...MANAGED_TOOL_NAMES]],['required_skills',skills]] as const){if(!Array.isArray(p[key])||p[key].length>100||p[key].some((n:any)=>typeof n!=='string'||!allowed.includes(n as never)))fail('注册包引用了当前未安装或未知的工具/技能。');}
 if(Object.keys(p.task_template).some(k=>!taskFields.has(k)))fail('任务模板含执行脚本、凭据、审批策略或未知字段。');
 if(/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\bsk-[A-Za-z0-9_-]{16,}/i.test(JSON.stringify(p)))fail('注册包中检测到凭据标记。');
 return p;
}
export function packageRegistry(stateDir:string,action:string,params:Record<string,any>,skills:string[]){
 const file=join(stateDir,'capability-packages.json');let entries:Package[]=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[];
 const persist=()=>{mkdirSync(stateDir,{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';try{writeFileSync(tmp,JSON.stringify(entries,null,2),{mode:0o600});renameSync(tmp,file);}finally{if(existsSync(tmp))unlinkSync(tmp);}};
 const mark=(p:Package,a:string)=>p.history.push({action:a,actor_ref:params.actor_ref||'local-owner',at:new Date().toISOString()});
 if(action==='list')return {items:entries,execution_verified:false};
 if(action==='import'){
  const manifest=packageManifest(params.manifest,skills),same=entries.find(p=>p.manifest.name===manifest.name&&p.manifest.version===manifest.version);
  if(same){if(!isDeepStrictEqual(same.manifest,manifest))fail('同名同版本已存在不同内容，请使用新版本号。');return same;}
  const p:Package={package_id:'capability-'+randomUUID(),manifest,content_hash:'sha256:'+createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),state:'draft',created_at:new Date().toISOString(),history:[]};mark(p,'import');entries.push(p);persist();return p;
 }
 const p=entries.find(p=>p.package_id===params.package_id);if(!p)fail('注册包不存在。');
 if(action==='preflight'){
  if(p.state!=='draft')fail('仅草稿可预检。');packageManifest(p.manifest,skills);validateTaskInput({task_id:randomUUID(),goal:'',...p.manifest.task_template});p.state='preflighted';mark(p,'static_preflight');persist();return {...p,execution_verified:false};
 }
 if(action==='approve'||action==='retire'){
  if(params.allow_admin!==true)fail('注册包审批和停用需要Host管理员权限。');
  if(action==='approve'&&p.state!=='preflighted')fail('先完成声明与任务参数预检，再批准使用。');p.state=action==='approve'?'approved':'retired';mark(p,action);persist();return p;
 }
 if(action==='instantiate'){
  if(p.state!=='approved')fail('只能使用已批准且未停用的注册包。');
  const overrides=params.overrides||{};if(!object(overrides)||Object.keys(overrides).some(k=>!taskFields.has(k)))fail('只能修改任务参数，不能加入脚本、凭据或审批授权。');
  const request={task_id:randomUUID(),goal:'',...p.manifest.task_template,...overrides,source_package:{package_id:p.package_id,content_hash:p.content_hash}};validateTaskInput(request);return {request,execution_started:false,source_package:{package_id:p.package_id,content_hash:p.content_hash},note:'返回待确认任务参数；不创建或执行任务，不新增权限。'};
 }
 if(action==='check_source'){if(p.state!=='approved'||p.content_hash!==params.content_hash)fail('来源注册包已停用或内容摘要不匹配，请重新选择。');return p;}
 fail('不支持的注册包操作。');
}
