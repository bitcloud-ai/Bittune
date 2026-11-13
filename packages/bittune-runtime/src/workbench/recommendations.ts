import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export const recommendationSchema = Type.Object({
  summary: Type.String({minLength:1,maxLength:2000}),
  candidates: Type.Array(Type.Object({
    label: Type.String({minLength:1,maxLength:120}),
    model_id: Type.String({minLength:1,maxLength:200}),
    model_path: Type.String({maxLength:4096}),
    quantization: Type.String({minLength:1,maxLength:80}),
    runtime_kind: StringEnum(["vllm","sglang"]),
    runtime_major: Type.String({maxLength:16,pattern:"^[0-9]*$"}),
    image_repository: Type.String({maxLength:256}),
    image_digest: Type.String({pattern:"^(|sha256:[a-f0-9]{64})$"}),
    max_context: Type.Integer({minimum:128,maximum:1048576}),
    max_sequences: Type.Integer({minimum:1,maximum:256}),
    tensor_parallel_size: Type.Optional(Type.Integer({minimum:1,maximum:64})),
    pipeline_parallel_size: Type.Optional(Type.Integer({minimum:1,maximum:64,description:"仅vLLM支持，SGLang使用1"})),
    gpu_device_ids: Type.Optional(Type.Array(Type.Integer({minimum:0}),{maxItems:64,uniqueItems:true})),
    cache_disabled: Type.Optional(Type.Boolean({description:"正式对照时关闭前缀复用缓存；之后仍由Core核对实际命令证据"})),
    memory: Type.Number({minimum:0.1,maximum:0.95}),
    input_tokens: Type.Integer({minimum:1,maximum:1048576}),
    output_tokens: Type.Integer({minimum:1,maximum:1048576}),
    concurrency: Type.Integer({minimum:1,maximum:16}),
    request_count: Type.Integer({minimum:1,maximum:64}),
    max_trials: Type.Integer({minimum:0,maximum:3}),
    rationale: Type.String({minLength:1,maxLength:2000}),
    limitations: Type.Array(Type.String({minLength:1,maxLength:500}),{minItems:1,maxItems:8}),
  },{additionalProperties:false}),{minItems:1,maxItems:3}),
},{additionalProperties:false});
export type RecommendationOutput = Static<typeof recommendationSchema>;

export function recommendationHardware(snapshot: Record<string,any>) {
  const gib=(x:unknown)=>typeof x==="number"?Math.round(x/1024**3*10)/10:null;
  return {
    gpus:(snapshot.gpus || []).map((g:any)=>({index:g.index ?? null,name:g.name,total_memory_gib:gib(g.memory_total_bytes),free_memory_gib:gib(g.memory_free_bytes),driver_version:g.driver_version})),
    cuda_version:snapshot.cuda_version || null,
    cpu_architecture:snapshot.cpu?.Architecture || null,
    cpu_count:snapshot.cpu?.["CPU(s)"] || null,
    system_memory_gib:gib(snapshot.memory?.total_bytes),
    os:snapshot.os?.PRETTY_NAME || snapshot.kernel || null,
  };
}
