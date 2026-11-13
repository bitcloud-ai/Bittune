import assert from "node:assert/strict";
import { test } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { recommendationSchema, recommendationHardware } from "../packages/bittune-runtime/src/workbench/recommendations.ts";

test("recommendation output accepts missing assets and rejects unsafe numeric defaults; hardware omits host identifiers", () => {
  const tool = {name:"submit_recommendations", description:"draft", parameters:recommendationSchema};
  const candidate = {
    label:"建议",model_id:"Qwen/example",model_path:"",quantization:"AWQ",runtime_kind:"vllm",runtime_major:"",
    image_repository:"vllm/vllm-openai",image_digest:"",max_context:4096,max_sequences:4,memory:0.8,tensor_parallel_size:8,gpu_device_ids:[0,1,2,3,4,5,6,7],
    input_tokens:128,output_tokens:32,concurrency:1,request_count:4,max_trials:0,rationale:"预估可容纳",limitations:["权重和镜像待准备"],
  };
  const call = (memory:number) => validateToolArguments(tool,{type:"toolCall",id:"draft",name:tool.name,arguments:{summary:"建议草稿",candidates:[{...candidate,memory}]}});
  assert.equal((call(0.8) as any).candidates[0].model_path, "");
  assert.equal((call(0.8) as any).candidates[0].tensor_parallel_size,8);
  assert.throws(()=>call(1));
  const summary = recommendationHardware({host_id:"private",raw_logs:"private",gpus:[{name:"GPU",uuid:"private",memory_total_bytes:32*1024**3,memory_free_bytes:30*1024**3}],cpu:{Architecture:"x86_64","CPU(s)":"16"},memory:{total_bytes:64*1024**3}});
  assert.equal(summary.gpus[0].total_memory_gib,32);
  assert.ok(!JSON.stringify(summary).includes("private"));
});
