import { BittuneError } from "./errors.ts";
import { compileSglangEngineArgs, materializeSglangConfiguration, sglangCapabilitySnapshot, sglangConfigurationFingerprint, SGLANG_CAPABILITY_VERSION, SGLANG_SERVING_PARAMETERS } from "./sglang-capabilities.ts";
import { compileVllmEngineArgs, materializeVllmConfiguration, vllmCapabilitySnapshot, vllmConfigurationFingerprint, VLLM_CAPABILITY_VERSION, VLLM_SERVING_PARAMETERS, type ServingConfiguration, type ServingParameterDescriptor } from "./vllm-capabilities.ts";

export const RUNTIME_KINDS = ["vllm", "sglang"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly capabilityVersion: string;
  readonly parameters: readonly ServingParameterDescriptor[];
  capabilitySnapshot(runtime?: { image_repository: string; image_digest: string }): Record<string, unknown>;
  materializeConfiguration(value: unknown): ServingConfiguration;
  configurationFingerprint(configuration: ServingConfiguration): string;
  compileEngineArgs(configuration: ServingConfiguration, supportedFlags?: Iterable<string>): string[];
}

const adapters: Record<RuntimeKind, RuntimeAdapter> = {
  vllm: {
    kind: "vllm",
    capabilityVersion: VLLM_CAPABILITY_VERSION,
    parameters: VLLM_SERVING_PARAMETERS,
    capabilitySnapshot: vllmCapabilitySnapshot,
    materializeConfiguration: materializeVllmConfiguration,
    configurationFingerprint: vllmConfigurationFingerprint,
    compileEngineArgs: compileVllmEngineArgs,
  },
  sglang: {
    kind: "sglang",
    capabilityVersion: SGLANG_CAPABILITY_VERSION,
    parameters: SGLANG_SERVING_PARAMETERS,
    capabilitySnapshot: sglangCapabilitySnapshot,
    materializeConfiguration: materializeSglangConfiguration,
    configurationFingerprint: sglangConfigurationFingerprint,
    compileEngineArgs: compileSglangEngineArgs,
  },
};

export function isRuntimeKind(value: unknown): value is RuntimeKind {
  return typeof value === "string" && (RUNTIME_KINDS as readonly string[]).includes(value);
}

export function getRuntimeAdapter(kind: RuntimeKind): RuntimeAdapter {
  return adapters[kind];
}

export function requireRuntimeAdapter(kind: unknown): RuntimeAdapter {
  if (!isRuntimeKind(kind)) throw new BittuneError("unsupported_runtime_kind", `Bittune does not support runtime_kind ${String(kind)}.`, false, { supported_runtime_kinds: RUNTIME_KINDS });
  return getRuntimeAdapter(kind);
}

export function compileRuntimeDockerGpuArgs(kind: RuntimeKind, configuration: ServingConfiguration): string[] {
  const materialized = getRuntimeAdapter(kind).materializeConfiguration(configuration);
  const devices = materialized.gpu_device_ids;
  if (!Array.isArray(devices) || devices.some((item) => typeof item !== "number" || !Number.isInteger(item) || item < 0)) {
    throw new BittuneError("invalid_serving_configuration", "gpu_device_ids must be a supported GPU index array.", false);
  }
  return ["--gpus", devices.length ? `device=${devices.join(",")}` : "all"];
}
