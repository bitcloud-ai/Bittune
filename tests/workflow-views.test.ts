import assert from "node:assert/strict";
import {test} from "node:test";
import {accountingView} from "../packages/bittune-runtime/src/workflows/views.ts";
import {modelMessage} from "../packages/bittune-runtime/src/workflows/model-message.ts";
test("CLI/Web核算只取真实指标：保留零值，不以计划填补缺失",()=>{
 const row={measurement_status:"complete",metrics:{output_tokens_total:999},measurement:{metrics:{output_tokens_total:0,output_tokens_per_second:2}}};
 const d=accountingView(row,1);assert.equal(d.observed.output_tokens_total,0);assert.equal(d.observed.input_tokens_total,null);assert.equal(d.estimated.output_tokens,7200);
 assert.equal(accountingView({...row,measurement_status:"partial"},1).estimated.output_tokens,null);
});
test("CLI/Web模型回复不混入思考文本",()=>{
 assert.equal(modelMessage({content:"<think>内部推理</think>最终回复"}).content,"最终回复");
 assert.equal(modelMessage({content:"推理</think>最终回复"}).content,"最终回复");
});
