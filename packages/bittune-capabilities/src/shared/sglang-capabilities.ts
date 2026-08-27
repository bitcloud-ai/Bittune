import { BittuneError } from "./errors.ts";
import { canonicalJson, sha256 } from "./identifiers.ts";
import type { ServingConfiguration, ServingParameterDescriptor, ServingScalar } from "./vllm-capabilities.ts";

export const SGLANG_CAPABILITY_VERSION = "sglang-managed-v1";

export const SGLANG_SERVING_PARAMETERS: ServingParameterDescriptor[] = [
  { name: "dtype", type: "enum", default: "auto", values: ["auto", "bfloat16", "float16", "float32"], description: "Model execution dtype exposed by SGLang." },
  { name: "tensor_parallel_size", type: "integer", default: 1, minimum: 1, description: "SGLang tensor-parallel worker count." },
  { name: "gpu_device_ids", type: "integer_array", default: [], minimum: 0, dependencies: ["tensor_parallel_size"], description: "Explicit GPU indexes for this managed container. Empty means Docker selects all visible GPUs." },
  { name: "context_length", type: "integer", unit: "tokens", default: 8192, minimum: 1, description: "Conservative first-run SGLang context length." },
  { name: "max_running_requests", type: "integer", default: 4, minimum: 1, description: "Conservative first-run request concurrency." },
  { name: "chunked_prefill_size", type: "integer", unit: "tokens", default: 4096, minimum: 1, description: "Conservative first-run token budget used by SGLang chunked prefill." },
  { name: "mem_fraction_static", type: "number", default: 0.8, minimum: 0, exclusive_minimum: true, maximum: 1, description: "Conservative first-run fraction of GPU memory reserved by SGLang." },
  { name: "disable_cuda_graph", type: "boolean", default: false, description: "Disable CUDA graph execution in SGLang." },
  { name: "disable_radix_cache", type: "boolean", default: false, description: "Disable SGLang radix-cache prefix reuse." },
];

const descriptorByName = new Map(SGLANG_SERVING_PARAMETERS.map((item) => [item.name, item]));

export function sglangCapabilitySnapshot(runtime?: { image_repository: string; image_digest: string }) {
  return {
    runtime_kind: "sglang" as const,
    capability_version: SGLANG_CAPABILITY_VERSION,
    ...(runtime ? { runtime } : {}),
    parameters: SGLANG_SERVING_PARAMETERS,
    unsupported: [
      { category: "arbitrary_engine_args", reason: "The managed adapter only accepts the declared serving_configuration fields." },
      { category: "unverified_cli_flags", reason: "A non-default parameter is accepted only when the selected image exposes its mapped SGLang CLI flag." },
    ],
  };
}

function invalid(name: string, message: string): never {
  throw new BittuneError("invalid_serving_configuration", `${name}: ${message}`, false);
}

function assertDescriptorValue(descriptor: ServingParameterDescriptor, value: unknown): ServingScalar {
  if (descriptor.type === "boolean") {
    if (typeof value !== "boolean") invalid(descriptor.name, "must be boolean");
    return value;
  }
  if (descriptor.type === "enum") {
    if (typeof value !== "string" || !descriptor.values?.includes(value)) invalid(descriptor.name, `must be one of ${descriptor.values?.join(", ")}`);
    return value;
  }
  if (descriptor.type === "integer_array") {
    if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item) || item < (descriptor.minimum ?? -Infinity) || item > (descriptor.maximum ?? Infinity))) invalid(descriptor.name, "must be an array of supported GPU indexes");
    if (new Set(value).size !== value.length) invalid(descriptor.name, "must not contain duplicate GPU indexes");
    return [...value] as number[];
  }
  if (typeof value !== "number" || !Number.isFinite(value) || (descriptor.type === "integer" && !Number.isInteger(value))) invalid(descriptor.name, `must be a finite ${descriptor.type}`);
  if (descriptor.minimum !== undefined && (descriptor.exclusive_minimum ? value <= descriptor.minimum : value < descriptor.minimum)) invalid(descriptor.name, `must be ${descriptor.exclusive_minimum ? ">" : ">="} ${descriptor.minimum}`);
  if (descriptor.maximum !== undefined && value > descriptor.maximum) invalid(descriptor.name, `must be <= ${descriptor.maximum}`);
  return value;
}

export function materializeSglangConfiguration(value: unknown): ServingConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("serving_configuration", "must be an object");
  const raw = value as Record<string, unknown>;
  const result: ServingConfiguration = {};
  for (const descriptor of SGLANG_SERVING_PARAMETERS) result[descriptor.name] = descriptor.default;
  for (const [name, item] of Object.entries(raw)) {
    const descriptor = descriptorByName.get(name);
    if (!descriptor) throw new BittuneError("unsupported_serving_parameter", `SGLang Capability does not expose parameter ${name}.`, false);
    result[name] = assertDescriptorValue(descriptor, item);
  }
  const devices = result.gpu_device_ids as number[];
  if (devices.length > 0 && devices.length < (result.tensor_parallel_size as number)) invalid("gpu_device_ids", "must contain at least tensor_parallel_size devices");
  if ((result.chunked_prefill_size as number) < (result.max_running_requests as number)) invalid("chunked_prefill_size", "must be >= max_running_requests");
  return result;
}

export function sglangConfigurationFingerprint(configuration: ServingConfiguration): string {
  return sha256(canonicalJson({ capability_version: SGLANG_CAPABILITY_VERSION, configuration: materializeSglangConfiguration(configuration) }));
}

function usesNonDefault(configuration: ServingConfiguration, name: string): boolean {
  const descriptor = descriptorByName.get(name);
  return descriptor !== undefined && canonicalJson(configuration[name]) !== canonicalJson(descriptor.default);
}

function appendSupportedArgument(args: string[], supportedFlags: Set<string> | undefined, flag: string, value: string, configuration: ServingConfiguration, parameter: string): void {
  if (!supportedFlags || supportedFlags.has(flag)) {
    args.push(flag, value);
    return;
  }
  if (usesNonDefault(configuration, parameter)) {
    throw new BittuneError("runtime_cli_incompatible", `The selected SGLang image does not support ${flag}, required by ${parameter}.`, false, { flag, parameter });
  }
}

export function compileSglangEngineArgs(configuration: ServingConfiguration, supportedFlags?: Iterable<string>): string[] {
  const config = materializeSglangConfiguration(configuration);
  const flags = supportedFlags ? new Set(supportedFlags) : undefined;
  const args: string[] = [];
  appendSupportedArgument(args, flags, "--dtype", String(config.dtype), config, "dtype");
  appendSupportedArgument(args, flags, "--tp-size", String(config.tensor_parallel_size), config, "tensor_parallel_size");
  appendSupportedArgument(args, flags, "--context-length", String(config.context_length), config, "context_length");
  appendSupportedArgument(args, flags, "--max-running-requests", String(config.max_running_requests), config, "max_running_requests");
  appendSupportedArgument(args, flags, "--chunked-prefill-size", String(config.chunked_prefill_size), config, "chunked_prefill_size");
  appendSupportedArgument(args, flags, "--mem-fraction-static", String(config.mem_fraction_static), config, "mem_fraction_static");
  if (config.disable_cuda_graph) {
    if (flags && !flags.has("--disable-cuda-graph")) throw new BittuneError("runtime_cli_incompatible", "The selected SGLang image does not support --disable-cuda-graph.", false, { flag: "--disable-cuda-graph" });
    args.push("--disable-cuda-graph");
  }
  if (config.disable_radix_cache) {
    if (flags && !flags.has("--disable-radix-cache")) throw new BittuneError("runtime_cli_incompatible", "The selected SGLang image does not support --disable-radix-cache.", false, { flag: "--disable-radix-cache" });
    args.push("--disable-radix-cache");
  }
  return args;
}
