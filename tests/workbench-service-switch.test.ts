import assert from "node:assert/strict";
import { test } from "node:test";
import { switchFrozenPlan, type ManagedCall } from "../packages/bittune-runtime/src/workbench/service-switch.ts";

test("service switching validates and freezes before stop, then starts the selected plan", async()=>{
 const calls:string[]=[];
 const call:ManagedCall=async(tool,p)=>{calls.push(tool+":"+(p.action||""));if(tool==="inspect_environment")return{data:{hardware_snapshot:{hardware_snapshot_id:"fresh"}}};if(p.action==="create")return{data:{plan:{plan_id:"derived"}}};if(p.action==="validate")return{data:{validation:{state:"valid"}}};if(tool==="inspect_service")return{data:{current_container_state:{status:"running",running:true}}};return{data:{service:{observed_state:"exited",endpoint:"new"}}};};
 await switchFrozenPlan(call,"old","selected","goal");
 assert.deepEqual(calls,["inspect_environment:","plan_deployment:create","plan_deployment:validate","plan_deployment:freeze","inspect_service:get","deploy_service:stop","deploy_service:start"]);
});
test("invalid targets or an unconfirmed stop never start a replacement",async()=>{
 for(const invalid of [true,false]){
 const calls:string[]=[];
 const call:ManagedCall=async(tool,p)=>{calls.push(tool+":"+p.action);if(tool==="inspect_environment")return{data:{hardware_snapshot:{hardware_snapshot_id:"fresh"}}};if(p.action==="create")return{data:{plan:{plan_id:"derived"}}};if(p.action==="validate")return{data:{validation:{state:invalid?"invalid":"valid"}}};if(tool==="inspect_service")return{data:{current_container_state:{status:"running",running:true}}};return{data:{service:{observed_state:"running"}}};};
 await assert.rejects(switchFrozenPlan(call,"old","selected","goal"));assert.ok(!calls.includes("deploy_service:start"));if(invalid)assert.ok(!calls.includes("deploy_service:stop"));
 }
});
