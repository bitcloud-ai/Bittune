import {randomUUID} from "node:crypto";
import {createBashTool} from "../core/tools/bash.ts";
import {evaluateGenericCall} from "../harness/runtime-policy.ts";
import {evaluateScopedGeneric,type TaskScope} from "../harness/task-scope.ts";

/** Execute an operator-selected preparation command through the existing guards/tool. */
export async function runFixedPreparation(options:{
 command:string;cwd:string;scope:TaskScope;protectedRoots:string[];signal:AbortSignal;
 approve:(reason:string)=>Promise<boolean>;onStart:()=>void;
 timeoutSeconds?:number;
 onUpdate?:(text:string)=>void;
}){
 const {command,cwd,scope,signal}=options;
 if(!scope.allow_execution||!scope.preparation_commands?.includes(command))throw new Error("task_scope_denied：制品命令不在任务授权范围。");
 const input={toolName:"bash" as const,command,cwd,protectedRoots:options.protectedRoots};
 const basic=evaluateGenericCall(input);
 const outcome=basic.decision==="deny"?basic:evaluateScopedGeneric(input,scope);
 if(outcome.decision==="deny")throw new Error(outcome.reason);
 if(signal.aborted||outcome.decision==="ask"&&!await options.approve(outcome.reason)||signal.aborted)return;
 options.onStart();
 return createBashTool(cwd,{exposeSessionEnvironment:false}).execute(randomUUID(),{command,timeout:options.timeoutSeconds ?? 3600},signal,update=>{
  const text=update.content.filter(c=>c.type==="text").map(c=>c.text).join("\n");
  if(text)options.onUpdate?.(text);
 });
}
