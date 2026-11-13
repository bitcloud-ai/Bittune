import {test} from "node:test";
import assert from "node:assert/strict";
import {validateTuningBaseline,canReleaseTuningBaseline,bindTuningObjective} from "../packages/bittune-runtime/src/workbench/tuning-baseline.ts";

test("selected runtime is the baseline and cannot be stopped before complete measurement",()=>{
 const source={id:"service-example",payload:{ownership:"managed",desired:"running",observed_state:"ready",plan_id:"plan-example"}};
 const plan={plan_id:"plan-example",status:"frozen",validation:{state:"valid"}};
 assert.doesNotThrow(()=>validateTuningBaseline(source,plan,"plan-example"));
 assert.throws(()=>validateTuningBaseline(source,plan,"other-plan"));
 assert.throws(()=>validateTuningBaseline({...source,payload:{...source.payload,ownership:"external"}},plan,"plan-example"));
 assert.equal(canReleaseTuningBaseline([],2),false);
 assert.equal(canReleaseTuningBaseline([{kind:"suite_result",id:"suite-one",payload:{rows:[{measurement_status:"partial"}]}}],2),false);
 const complete={kind:"suite_result",id:"suite-one",payload:{rows:[{measurement_status:"complete"}]}};
 assert.equal(canReleaseTuningBaseline([complete],2),true);
 assert.equal(canReleaseTuningBaseline([complete,{...complete,id:"suite-two"}],2),false);
 const tool:any={name:"compare_results",prepareArguments:(p:any)=>p};
 assert.equal((bindTuningObjective(tool,"mean_ttft_ms").prepareArguments!({objective:"output_tokens_per_second"}) as any).objective,"mean_ttft_ms");
});
