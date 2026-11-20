import {createHash} from 'node:crypto';
import {MANAGED_TOOL_NAMES,MANAGED_TOOL_DESCRIPTIONS} from '../harness/managed-tools.ts';
import {loadSkillsFromDir} from '../core/skills.ts';
import {VERSION} from '../config.ts';
export function capabilityCatalog(dir:string){const loaded=loadSkillsFromDir({dir,source:'product'});return {version:VERSION,tools:MANAGED_TOOL_NAMES.map(name=>({name,description:MANAGED_TOOL_DESCRIPTIONS[name],source:'builtin',state:'approved',version:VERSION})),skills:loaded.skills.map(s=>({name:s.name,description:s.description,source:'installed',state:'approved',model_invocation:!s.disableModelInvocation})),diagnostics:loaded.diagnostics.map(d=>({message:d.message}))};}
export function governanceView(tasks:Record<string,any>[]){
 const pending=tasks.filter(t=>t.state==='waiting_confirmation'&&t.pending).map(t=>({task_id:t.task_id,name:t.name,security_mode:t.security_mode,updated_at:t.updated_at,confirmation:t.pending}));
 const events=tasks.flatMap(t=>(t.events||[]).map((e:any)=>({task_id:t.task_id,name:t.name,state:t.state,type:e.type,message:e.message,actor_ref:e.actor_ref||null,at:e.at,source:'task_session_event',digest:'sha256:'+createHash('sha256').update(JSON.stringify([t.task_id,e.type,e.at,e.message,e.actor_ref||null])).digest('hex')}))).sort((a,b)=>b.at.localeCompare(a.at));
 return {pending,events,task_count:tasks.length,active_tasks:tasks.filter(t=>['queued','running','waiting_confirmation'].includes(t.state)).length,notes:['审批操作复用原任务确认，不创建第二套执行授权。','摘要用于核对展示内容；原始来源为任务会话和Core记录，不冒充组织签名审计链。']};
}
