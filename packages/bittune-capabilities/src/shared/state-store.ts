import { randomUUID, createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BittuneError } from "./errors.ts";
import { canonicalJson, requireId, requireVersion, sha256 } from "./identifiers.ts";
import type { ArtifactRef, Observation, ProvenanceType } from "./observation.ts";
import { pathInside } from "./atomic-files.ts";
import { redact, redactText } from "./redaction.ts";
import { requireRuntimeAdapter, type RuntimeKind } from "./runtime-adapter.ts";
import type { ServingConfiguration } from "./vllm-capabilities.ts";

/** The Runtime state family uses one schema. */
export const RUNTIME_SCHEMA_VERSION = 3;
export const OPTIMIZATION_SCHEMA_VERSION = RUNTIME_SCHEMA_VERSION;
const DEFAULT_NAMESPACE = "default";
const DEFAULT_ARTIFACT_RETENTION_DAYS = 30;
const DEFAULT_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024 * 1024;

function resolvedPathIsWithin(root: string, target: string): boolean {
  const relativeTarget = relative(resolve(root), resolve(target));
  return relativeTarget === "" || (!relativeTarget.startsWith(`..${sep}`) && relativeTarget !== ".." && !isAbsolute(relativeTarget));
}

export interface ArtifactRetentionPolicy {
  max_age_days: number;
  max_total_bytes: number;
}

function configuredNonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || !raw.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new BittuneError("artifact_retention_invalid", `${name} must be a non-negative integer.`, false);
  return value;
}

export function artifactRetentionPolicy(): ArtifactRetentionPolicy {
  return {
    max_age_days: configuredNonNegativeInteger("BITTUNE_ARTIFACT_RETENTION_DAYS", DEFAULT_ARTIFACT_RETENTION_DAYS),
    max_total_bytes: configuredNonNegativeInteger("BITTUNE_ARTIFACT_MAX_BYTES", DEFAULT_ARTIFACT_MAX_BYTES),
  };
}

export interface DeploymentPreset {
  schema_version: number;
  preset_id: string;
  version: string;
  model_id: string;
  model_revision: string;
  artifact_fingerprint?: string;
  runtime_kind: RuntimeKind;
  runtime_image_repository: string;
  runtime_image_digest: string;
  serving_configuration: ServingConfiguration;
  source_run_ids: string[];
  created_at: string;
  source: "published";
  content_hash: string;
}

export interface RuntimeCapabilityObservation {
  schema_version: typeof RUNTIME_SCHEMA_VERSION;
  capability_id: string;
  runtime_kind: RuntimeKind;
  runtime_image_repository: string;
  runtime_image_digest: string;
  runtime_image_id: string;
  runtime_capability_version: string;
  cli_version?: string;
  entrypoint: string;
  entrypoint_args: string[];
  supported_flags: string[];
  observed_at: string;
  expires_at: string;
  source_run_id: string;
  artifact_ids: string[];
  content_hash: string;
}

export interface MeasuredOperatingPoint {
  deployment_fingerprint: string;
  environment_fingerprint: string;
  workload_fingerprint: string;
  serving_configuration: ServingConfiguration;
  configuration_fingerprint: string;
  metrics: Record<string, unknown>;
  gates: Record<string, unknown>;
  source_run_ids: string[];
  measured_at: string;
  verification_status: "verified" | "validation_required" | "unverified";
}

export interface CapacityBaseline {
  schema_version: number;
  baseline_id: string;
  version: string;
  deployment_preset_id: string;
  deployment_preset_version: string;
  operating_points: MeasuredOperatingPoint[];
  capacity_envelope?: { search_strategy: string; boundary_evidence_run_ids: string[]; workload_fingerprint: string; configuration_fingerprint: string };
  source_run_ids: string[];
  candidate_run_id: string;
  candidate_hash: string;
  created_at: string;
  content_hash: string;
}

export interface ServiceObservation {
  desired_state: "running" | "stopped" | "unknown";
  observed_state: string;
  observed_at: string;
  observation_run_id?: string;
  freshness: "fresh" | "stale" | "unknown";
  state_generation: number;
}

export interface ServiceManifest {
  schema_version: number;
  instance_id: string;
  service_name: string;
  container_id: string;
  container_name: string;
  deployment_preset_id: string;
  deployment_preset_version: string;
  model_id: string;
  model_revision: string;
  runtime_kind: RuntimeKind;
  runtime_image_repository: string;
  runtime_image_digest: string;
  runtime_capability_version: string;
  runtime_cli_profile?: { version?: string; entrypoint?: string; supported_flags: string[]; supports_swap_space?: boolean };
  runtime_engine_args?: string[];
  endpoint_url: string;
  port: number;
  serving_configuration: ServingConfiguration;
  config_hash: string;
  created_at: string;
  observation: ServiceObservation;
  owner?: { kind: "experiment"; experiment_id: string; experiment_version: string; optimization_attempt_id?: string };
}

export interface ExperimentWorkload {
  mode: "closed_loop" | "open_loop"; concurrency: number; request_count: number; input_tokens: number; output_tokens: number; request_rate?: number; request_timeout_seconds?: number;
  workload_schema_version?: 1; provider_version?: string; argv_profile_version?: string; random_seed?: number; tokenizer_model_id?: string; chat_template?: string; stream?: boolean; ignore_eos?: boolean; warmup_requests?: number; warmup_timeout_seconds?: number;
}
export interface ExperimentSpec {
  schema_version: number; experiment_id: string; version: string; deployment_preset_id: string; deployment_preset_version: string; reference_service_instance_id: string; reference_service_configuration: ServingConfiguration; runtime_capability_version: string; experiment_kind: "runtime_tuning" | "capacity_exploration"; baseline_environment_run_id: string; objective_metric: "requests_per_second" | "output_tokens_per_second"; objective_target?: number;
  constraints: { min_success_rate?: number; max_mean_ttft_ms?: number; max_mean_e2e_latency_ms?: number; max_gpu_memory_bytes?: number };
  workload: ExperimentWorkload; allowed_workload?: { concurrency?: { minimum: number; maximum: number }; request_rate?: { minimum: number; maximum: number } }; allowed_parameters: Record<string, { minimum?: number; maximum?: number; values?: Array<boolean | number | string> }>;
  budget: { max_trials: number; max_total_duration_seconds: number; max_failures: number }; minimum_improvement_percent: number; required_repetitions: number; max_objective_cv_percent?: number; created_at: string; content_hash: string;
}
export type TrialResultClass = "valid" | "constraint_failed" | "failed" | "invalid_environment_drift" | "invalid_resource_contention";
export interface ExperimentTrial { schema_version: number; trial_id: string; experiment_id: string; experiment_version: string; configuration: ServingConfiguration; configuration_hash: string; workload: ExperimentWorkload; workload_fingerprint?: string; metric_normalizer_version?: string; request_samples_available?: boolean; pre_environment_run_id: string; post_environment_run_id: string; service_run_id: string; probe_run_id: string; benchmark_run_id: string; result_class: TrialResultClass; constraint_failures: string[]; metrics: Record<string, unknown>; evidence_duration_seconds: number; resource_contention?: { baseline_processes: number; trial_processes: number; reason: string }; created_at: string; content_hash: string; }
export interface ExperimentComparison { schema_version: number; comparison_id: string; experiment_id: string; experiment_version: string; trial_ids: string[]; valid_trial_ids: string[]; ranking: Array<{ configuration_hash: string; evaluation_keys?: string[]; trial_ids: string[]; objective_mean: number; objective_standard_deviation?: number; objective_cv_percent?: number; repetitions: number; stable: boolean; exclusion_reasons?: string[] }>; best_configuration_hash?: string; best_trial_ids: string[]; status: "objective_met" | "no_gain" | "budget_exhausted" | "unsafe" | "cancelled" | "in_progress" | "validation_required"; reason: string; algorithm_version?: string; candidate_run_id: string; candidate_hash: string; created_at: string; content_hash: string; }

export type OptimizationContextStatus = "active" | "completed" | "cancelled";
export type OptimizationAttemptState = "reserved" | "starting" | "ready" | "probing" | "benchmarking" | "measured" | "failed" | "cancelled" | "abandoned";
export type OptimizationCleanupStatus = "not_required" | "cleanup_pending" | "cleaned";
export interface OptimizationContext {
  schema_version: 3; context_id: string; title: string; status: OptimizationContextStatus;
  experiment_id: string; experiment_version: string;
  deployment_preset_id: string; deployment_preset_version: string; runtime_kind: RuntimeKind; runtime_image_digest: string; model_id: string; model_revision: string; runtime_capability_version: string;
  experiment_kind: ExperimentSpec["experiment_kind"]; objective_metric: ExperimentSpec["objective_metric"]; constraints: ExperimentSpec["constraints"]; workload: ExperimentWorkload; allowed_workload?: ExperimentSpec["allowed_workload"]; allowed_parameters: ExperimentSpec["allowed_parameters"]; budget: ExperimentSpec["budget"]; required_repetitions: number; max_objective_cv_percent: number;
  reference_service_configuration: ServingConfiguration; created_at: string; updated_at: string; content_hash: string;
}
export interface OptimizationCandidate {
  schema_version: 3; candidate_id: string; context_id: string; configuration: ServingConfiguration; configuration_hash: string; workload: ExperimentWorkload; workload_fingerprint: string; created_at: string; content_hash: string;
}
export interface OptimizationAttempt {
  schema_version: 3; attempt_id: string; context_id: string; candidate_id: string; evaluation_key: string; environment_run_id: string; environment_fingerprint: string; selected_gpu_uuids: string[]; lease_id: string; lease_expires_at: string;
  state: OptimizationAttemptState; cleanup_status: OptimizationCleanupStatus; run_ids: string[]; trial_id?: string; failure_code?: string; retest_reason?: string; budget_counted: boolean; budget_counted_at?: string; created_at: string; updated_at: string; completed_at?: string; content_hash: string;
}
export interface OptimizationGpuLease {
  schema_version: 3; lease_id: string; context_id: string; attempt_id: string; gpu_uuid: string; expires_at: string; released_at?: string; created_at: string; content_hash: string;
}

export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "incomplete";
export interface RunManifest {
  schema_version: number;
  run_id: string;
  namespace_id: string;
  session_id: string;
  tool_call_id: string;
  parent_run_id?: string;
  source_run_ids?: string[];
  tool_name: string;
  started_at: string;
  finished_at: string;
  status: RunStatus;
  provenance_type: ProvenanceType;
  input_hash: string;
  input: unknown;
  provider?: { name: string; version?: string };
  observation_hash: string;
  artifacts: ArtifactRef[];
}

type StartRunOptions = { session_id?: string; tool_call_id?: string; parent_run_id?: string; source_run_ids?: string[] };
type FinishRunArgs = {
  tool_name: string; started_at: string; status: Exclude<RunStatus, "running" | "incomplete">; provenance_type: ProvenanceType;
  input: unknown; provider?: { name: string; version?: string }; artifacts: ArtifactRef[]; observation: Observation; parent_run_id?: string; source_run_ids?: string[];
};
type JsonRow = { record_json: string };
type RunRow = {
  run_id: string; namespace_id: string; session_id: string; tool_call_id: string; parent_run_id: string | null; source_run_ids_json: string | null;
  tool_name: string; started_at: string; finished_at: string | null; status: RunStatus; provenance_type: ProvenanceType; input_json: string; input_hash: string; provider_json: string | null; observation_hash: string | null;
};
type SharedDatabase = { database: DatabaseSync; references: number };

const OPEN_DATABASES = new Map<string, SharedDatabase>();

function json(value: unknown): string { return JSON.stringify(value); }
function parse<T>(value: string): T { return JSON.parse(value) as T; }
function now(): string { return new Date().toISOString(); }
function isTextualMediaType(mediaType: string): boolean { return mediaType.startsWith("text/") || mediaType === "application/json" || mediaType.endsWith("+json"); }
/** A stable, opaque namespace for one local project/workspace. */
export function namespaceForWorkspace(cwd?: string): string {
  if (!cwd) return process.env.BITTUNE_NAMESPACE?.trim() || DEFAULT_NAMESPACE;
  const digest = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 20);
  return `workspace-${digest}`;
}

export class StateStore {
  readonly root: string;
  readonly namespaceId: string;
  private dbInstance: DatabaseSync | undefined;
  private initialized = false;
  private initializing: Promise<void> | undefined;

  constructor(root = process.env.BITTUNE_STATE_DIR || join(homedir(), ".bittune", "state"), namespaceId = process.env.BITTUNE_NAMESPACE || DEFAULT_NAMESPACE) {
    this.root = resolve(root);
    this.namespaceId = namespaceId;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  private get db(): DatabaseSync {
    if (!this.dbInstance) {
      let shared = OPEN_DATABASES.get(this.root);
      if (!shared) {
        const database = new DatabaseSync(join(this.root, "bittune.db"));
        database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
        this.createSchema(database);
        shared = { database, references: 0 };
        OPEN_DATABASES.set(this.root, shared);
      }
      shared.references += 1;
      this.dbInstance = shared.database;
    }
    return this.dbInstance;
  }

  /** Callers that own a short-lived Store can release Windows file handles. */
  close(): void {
    const database = this.dbInstance;
    if (!database) return;
    this.dbInstance = undefined;
    const shared = OPEN_DATABASES.get(this.root);
    if (!shared || shared.database !== database) {
      database.close();
      return;
    }
    shared.references -= 1;
    if (shared.references > 0) return;
    try {
      if (process.platform !== "win32") database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // A concurrent writer can prevent checkpointing; close still releases
      // this connection and the next open will recover the WAL safely.
    }
    database.close();
    OPEN_DATABASES.delete(this.root);
  }

  /** Working directory for run-scoped raw Provider output before it is registered as an Artifact (e.g. EvalScope JSON). */
  get runRoot(): string { return join(this.root, "runs"); }
  get artifactRoot(): string { return join(this.root, "artifacts"); }
  get hfCacheRoot(): string { return process.env.HF_HOME || join(homedir(), ".cache", "huggingface"); }
  get hfCacheRoots(): string[] {
    const configured = process.env.BITTUNE_MODEL_CACHE_ROOTS?.split(delimiter).map((item) => item.trim()).filter(Boolean) ?? [];
    return Array.from(new Set([process.env.HF_HUB_CACHE, this.hfCacheRoot, ...configured].filter((root): root is string => Boolean(root)).map((root) => resolve(root))));
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initializing) this.initializing = this.initializeOnce();
    await this.initializing;
  }

  private async initializeOnce(): Promise<void> {
    await mkdir(this.artifactRoot, { recursive: true, mode: 0o700 });
    this.db.prepare("INSERT OR IGNORE INTO namespaces(namespace_id, created_at) VALUES (?, ?)").run(this.namespaceId, now());
    await this.pruneExpiredEvidence();
    this.initialized = true;
  }

  async listRuntimePresets(): Promise<DeploymentPreset[]> {
    await this.initialize();
    return this.recordsRaw<DeploymentPreset>("SELECT record_json FROM runtime_presets WHERE namespace_id = ? ORDER BY preset_id, version_number", this.namespaceId).map((record) => {
      this.ensureRuntimeSchema(record);
      return record;
    });
  }

  async getRuntimePreset(presetId: string, version?: string): Promise<DeploymentPreset> {
    await this.initialize(); requireId(presetId, "preset_id"); if (version) requireVersion(version);
    const row = version
      ? this.db.prepare("SELECT record_json FROM runtime_presets WHERE namespace_id = ? AND preset_id = ? AND version = ?").get(this.namespaceId, presetId, version) as JsonRow | undefined
      : this.db.prepare("SELECT record_json FROM runtime_presets WHERE namespace_id = ? AND preset_id = ? ORDER BY version_number DESC LIMIT 1").get(this.namespaceId, presetId) as JsonRow | undefined;
    if (!row) throw new BittuneError("preset_not_found", `找不到 Runtime DeploymentPreset ${presetId}${version ? `/${version}` : ""}。Check list_deployment_presets for saved presets, or publish_deployment_preset before referencing this id.`, false, { preset_id: presetId, ...(version ? { version } : {}), remediation: "list_deployment_presets() or publish_deployment_preset(preset_id=…)" });
    const record = parse<DeploymentPreset>(row.record_json);
    this.ensureRuntimeSchema(record);
    return record;
  }

  async publishRuntimePreset(input: Omit<DeploymentPreset, "schema_version" | "version" | "created_at" | "source" | "content_hash"> & { expected_parent_version?: string }): Promise<DeploymentPreset> {
    await this.initialize(); requireId(input.preset_id, "preset_id");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(input.model_id) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(input.model_revision)) throw new BittuneError("invalid_input", "model_id or model_revision format is invalid.", false);
    const adapter = requireRuntimeAdapter(input.runtime_kind);
    if (!/^[a-z0-9][a-z0-9._:/-]{0,255}$/.test(input.runtime_image_repository) || !/^sha256:[a-f0-9]{64}$/.test(input.runtime_image_digest)) throw new BittuneError("invalid_input", "runtime identity format is invalid.", false);
    const sourceRunIds = [...new Set(input.source_run_ids)];
    if (sourceRunIds.some((id) => !/^run-[a-f0-9-]{36}$/.test(id))) throw new BittuneError("invalid_input", "source_run_ids contains an invalid Run ID.", false);
    return this.runtimeVersionedWrite("runtime-presets", input.preset_id, async (version) => {
      const { expected_parent_version: _parent, ...content } = input;
      const record: DeploymentPreset = { ...content, serving_configuration: adapter.materializeConfiguration(input.serving_configuration), source_run_ids: sourceRunIds, schema_version: RUNTIME_SCHEMA_VERSION, version, created_at: now(), source: "published", content_hash: "" };
      record.content_hash = sha256(canonicalJson({ ...record, content_hash: undefined }));
      this.db.prepare("INSERT INTO runtime_presets(namespace_id, preset_id, version, version_number, record_json) VALUES (?, ?, ?, ?, ?)").run(this.namespaceId, record.preset_id, record.version, this.versionNumber(record.version), json(record));
      return record;
    }, input.expected_parent_version);
  }

  async listRuntimeBaselines(): Promise<CapacityBaseline[]> { await this.initialize(); return this.recordsRaw<CapacityBaseline>("SELECT record_json FROM runtime_capacity_baselines WHERE namespace_id = ? ORDER BY baseline_id, version_number", this.namespaceId).map((record) => { this.ensureRuntimeSchema(record); return record; }); }
  async getRuntimeBaseline(baselineId: string, version?: string): Promise<CapacityBaseline> {
    await this.initialize(); requireId(baselineId, "baseline_id"); if (version) requireVersion(version);
    const row = version
      ? this.db.prepare("SELECT record_json FROM runtime_capacity_baselines WHERE namespace_id = ? AND baseline_id = ? AND version = ?").get(this.namespaceId, baselineId, version) as JsonRow | undefined
      : this.db.prepare("SELECT record_json FROM runtime_capacity_baselines WHERE namespace_id = ? AND baseline_id = ? ORDER BY version_number DESC LIMIT 1").get(this.namespaceId, baselineId) as JsonRow | undefined;
    if (!row) throw new BittuneError("baseline_not_found", `找不到 Runtime CapacityBaseline ${baselineId}${version ? `/${version}` : ""}。`);
    const record = parse<CapacityBaseline>(row.record_json); this.ensureRuntimeSchema(record); return record;
  }
  async publishRuntimeBaseline(record: Omit<CapacityBaseline, "schema_version" | "version" | "created_at" | "content_hash">): Promise<CapacityBaseline> {
    await this.initialize(); requireId(record.baseline_id, "baseline_id");
    return this.runtimeVersionedWrite("runtime-capacity-baselines", record.baseline_id, async (version) => {
      const stored: CapacityBaseline = { ...record, schema_version: RUNTIME_SCHEMA_VERSION, version, created_at: now(), content_hash: "" };
      stored.content_hash = sha256(canonicalJson({ ...stored, content_hash: undefined }));
      this.db.prepare("INSERT INTO runtime_capacity_baselines(namespace_id, baseline_id, version, version_number, record_json) VALUES (?, ?, ?, ?, ?)").run(this.namespaceId, stored.baseline_id, stored.version, this.versionNumber(stored.version), json(stored));
      return stored;
    });
  }

  async saveRuntimeService(manifest: ServiceManifest): Promise<void> {
    await this.initialize(); requireId(manifest.instance_id, "instance_id");
    if (manifest.schema_version !== RUNTIME_SCHEMA_VERSION) throw new BittuneError("state_schema_mismatch", "Runtime ServiceInstance must use schema v3.", false);
    this.db.prepare("INSERT INTO runtime_services(namespace_id, instance_id, record_json) VALUES (?, ?, ?) ON CONFLICT(namespace_id, instance_id) DO UPDATE SET record_json = excluded.record_json").run(this.namespaceId, manifest.instance_id, json(manifest));
  }
  async deleteRuntimeService(instanceId: string): Promise<void> {
    await this.initialize(); requireId(instanceId, "instance_id");
    this.db.prepare("DELETE FROM runtime_services WHERE namespace_id = ? AND instance_id = ?").run(this.namespaceId, instanceId);
  }
  async getRuntimeService(instanceId: string): Promise<ServiceManifest> {
    await this.initialize(); requireId(instanceId, "instance_id");
    const row = this.db.prepare("SELECT record_json FROM runtime_services WHERE namespace_id = ? AND instance_id = ?").get(this.namespaceId, instanceId) as JsonRow | undefined;
    if (!row) throw new BittuneError("service_not_found", `找不到 Runtime ServiceInstance ${instanceId}。`);
    const record = parse<ServiceManifest>(row.record_json); this.ensureRuntimeSchema(record); return record;
  }
  async listRuntimeServices(): Promise<ServiceManifest[]> { await this.initialize(); return this.recordsRaw<ServiceManifest>("SELECT record_json FROM runtime_services WHERE namespace_id = ? ORDER BY instance_id", this.namespaceId).map((record) => { this.ensureRuntimeSchema(record); return record; }); }
  async markRuntimeServicesStale(): Promise<void> { for (const service of await this.listRuntimeServices()) { const observation = service.observation; await this.saveRuntimeService({ ...service, observation: { ...observation, freshness: "stale" as const, observed_at: now(), state_generation: observation.state_generation + 1 } }); } }
  async recordRuntimeServiceObservation(instanceId: string, observedState: string, runId: string | undefined, desiredState?: ServiceObservation["desired_state"]): Promise<ServiceManifest> {
    const service = await this.getRuntimeService(instanceId); const previous = service.observation;
    const freshness: ServiceObservation["freshness"] = runId ? "fresh" : "unknown";
    const updated: ServiceManifest = { ...service, observation: { desired_state: desiredState ?? previous.desired_state, observed_state: observedState, observed_at: now(), ...(runId ? { observation_run_id: runId } : {}), freshness, state_generation: previous.state_generation + 1 } };
    await this.saveRuntimeService(updated); return updated;
  }

  async saveRuntimeCapabilityObservation(record: Omit<RuntimeCapabilityObservation, "schema_version" | "content_hash">): Promise<RuntimeCapabilityObservation> {
    await this.initialize();
    requireId(record.capability_id, "capability_id");
    if (!/^sha256:[a-f0-9]{64}$/.test(record.runtime_image_digest) || !/^sha256:[a-f0-9]{64}$/.test(record.runtime_image_id)) {
      throw new BittuneError("invalid_input", "Runtime capability observation requires immutable image digest and image ID.", false);
    }
    if (!record.entrypoint.trim() || !record.runtime_capability_version.trim()) {
      throw new BittuneError("invalid_input", "Runtime capability observation requires entrypoint and capability version.", false);
    }
    if (!Number.isFinite(Date.parse(record.observed_at)) || !Number.isFinite(Date.parse(record.expires_at)) || Date.parse(record.expires_at) <= Date.parse(record.observed_at)) {
      throw new BittuneError("invalid_input", "Runtime capability observation expiry is invalid.", false);
    }
    this.runRow(record.source_run_id);
    const sourceArtifacts = new Set(this.runArtifacts(record.source_run_id).map((item) => item.artifact_id));
    if (!record.artifact_ids.length || record.artifact_ids.some((artifactId) => !sourceArtifacts.has(artifactId))) {
      throw new BittuneError("evidence_incomplete", "Capability observation must reference artifacts written by its source Run.", false);
    }
    const stored: RuntimeCapabilityObservation = {
      ...record,
      entrypoint_args: [...record.entrypoint_args],
      supported_flags: [...new Set(record.supported_flags)].sort(),
      artifact_ids: [...new Set(record.artifact_ids)],
      schema_version: RUNTIME_SCHEMA_VERSION,
      content_hash: "",
    };
    stored.content_hash = sha256(canonicalJson({ ...stored, content_hash: undefined }));
    this.db.prepare("INSERT INTO runtime_capability_observations(namespace_id, capability_id, runtime_kind, runtime_image_digest, runtime_image_id, observed_at, expires_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      this.namespaceId, stored.capability_id, stored.runtime_kind, stored.runtime_image_digest, stored.runtime_image_id, stored.observed_at, stored.expires_at, json(stored),
    );
    return stored;
  }

  async getFreshRuntimeCapabilityObservation(input: { runtime_kind: RuntimeKind; runtime_image_repository: string; runtime_image_digest: string; runtime_image_id: string; runtime_capability_version: string; at?: Date }): Promise<RuntimeCapabilityObservation> {
    await this.initialize();
    const at = (input.at ?? new Date()).toISOString();
    const rows = this.db.prepare("SELECT record_json FROM runtime_capability_observations WHERE namespace_id = ? AND runtime_kind = ? AND runtime_image_digest = ? AND runtime_image_id = ? AND expires_at > ? ORDER BY observed_at DESC").all(
      this.namespaceId, input.runtime_kind, input.runtime_image_digest, input.runtime_image_id, at,
    ) as JsonRow[];
    const record = rows.map((row) => parse<RuntimeCapabilityObservation>(row.record_json)).find((item) => item.runtime_image_repository === input.runtime_image_repository && item.runtime_capability_version === input.runtime_capability_version);
    if (!record) throw new BittuneError("runtime_capability_observation_required", `A fresh image-specific Runtime capability observation is required before starting a managed service. Run observe_runtime_capability(deployment_preset_id=…) for the preset image ${input.runtime_image_repository}@${input.runtime_image_digest}, then retry start_managed_service.`, false, { runtime_kind: input.runtime_kind, runtime_image_digest: input.runtime_image_digest, runtime_image_id: input.runtime_image_id, remediation: `observe_runtime_capability(deployment_preset_id=…) -> start_managed_service(deployment_preset_id=…)` });
    this.ensureRuntimeSchema(record);
    return record;
  }

  async listRuntimeCapabilityObservations(): Promise<RuntimeCapabilityObservation[]> {
    await this.initialize();
    return this.recordsRaw<RuntimeCapabilityObservation>("SELECT record_json FROM runtime_capability_observations WHERE namespace_id = ? ORDER BY observed_at DESC", this.namespaceId).map((record) => {
      this.ensureRuntimeSchema(record);
      return record;
    });
  }

  async listRuntimeExperimentSpecs(): Promise<ExperimentSpec[]> { await this.initialize(); return this.recordsRaw<ExperimentSpec>("SELECT record_json FROM runtime_experiment_specs WHERE namespace_id = ? ORDER BY experiment_id, version_number", this.namespaceId).map((record) => { this.ensureRuntimeSchema(record); return record; }); }
  async getRuntimeExperimentSpec(experimentId: string, version?: string): Promise<ExperimentSpec> {
    await this.initialize(); requireId(experimentId, "experiment_id"); if (version) requireVersion(version);
    const row = version
      ? this.db.prepare("SELECT record_json FROM runtime_experiment_specs WHERE namespace_id = ? AND experiment_id = ? AND version = ?").get(this.namespaceId, experimentId, version) as JsonRow | undefined
      : this.db.prepare("SELECT record_json FROM runtime_experiment_specs WHERE namespace_id = ? AND experiment_id = ? ORDER BY version_number DESC LIMIT 1").get(this.namespaceId, experimentId) as JsonRow | undefined;
    if (!row) throw new BittuneError("experiment_not_found", `找不到 Runtime ExperimentSpec ${experimentId}${version ? `/${version}` : ""}。`);
    const record = parse<ExperimentSpec>(row.record_json); this.ensureRuntimeSchema(record); return record;
  }
  async publishRuntimeExperimentSpec(input: Omit<ExperimentSpec, "schema_version" | "version" | "created_at" | "content_hash"> & { expected_parent_version?: string }): Promise<ExperimentSpec> {
    await this.initialize(); requireId(input.experiment_id, "experiment_id");
    return this.runtimeVersionedWrite("runtime-experiment-specs", input.experiment_id, async (version) => {
      const { expected_parent_version: _parent, ...content } = input;
      const stored: ExperimentSpec = { ...content, schema_version: RUNTIME_SCHEMA_VERSION, version, created_at: now(), content_hash: "" };
      stored.content_hash = sha256(canonicalJson({ ...stored, content_hash: undefined }));
      this.db.prepare("INSERT INTO runtime_experiment_specs(namespace_id, experiment_id, version, version_number, record_json) VALUES (?, ?, ?, ?, ?)").run(this.namespaceId, stored.experiment_id, stored.version, this.versionNumber(stored.version), json(stored));
      return stored;
    }, input.expected_parent_version);
  }
  async saveRuntimeExperimentTrial(record: Omit<ExperimentTrial, "schema_version" | "created_at" | "content_hash">): Promise<ExperimentTrial> {
    await this.initialize(); requireId(record.trial_id, "trial_id"); requireId(record.experiment_id, "experiment_id"); requireVersion(record.experiment_version);
    const stored: ExperimentTrial = { ...record, schema_version: RUNTIME_SCHEMA_VERSION, created_at: now(), content_hash: "" };
    stored.content_hash = sha256(canonicalJson({ ...stored, content_hash: undefined }));
    this.db.prepare("INSERT INTO runtime_experiment_trials(namespace_id, experiment_id, trial_id, record_json) VALUES (?, ?, ?, ?)").run(this.namespaceId, stored.experiment_id, stored.trial_id, json(stored)); return stored;
  }
  async listRuntimeExperimentTrials(experimentId: string): Promise<ExperimentTrial[]> { await this.initialize(); requireId(experimentId, "experiment_id"); return this.recordsRaw<ExperimentTrial>("SELECT record_json FROM runtime_experiment_trials WHERE namespace_id = ? AND experiment_id = ? ORDER BY rowid", this.namespaceId, experimentId).map((record) => { this.ensureRuntimeSchema(record); return record; }); }
  async getRuntimeExperimentTrial(experimentId: string, trialId: string): Promise<ExperimentTrial> {
    await this.initialize(); requireId(experimentId, "experiment_id"); requireId(trialId, "trial_id");
    const row = this.db.prepare("SELECT record_json FROM runtime_experiment_trials WHERE namespace_id = ? AND experiment_id = ? AND trial_id = ?").get(this.namespaceId, experimentId, trialId) as JsonRow | undefined;
    if (!row) throw new BittuneError("trial_not_found", `找不到 Runtime Trial ${trialId}。`); const record = parse<ExperimentTrial>(row.record_json); this.ensureRuntimeSchema(record); return record;
  }
  async saveRuntimeExperimentComparison(record: Omit<ExperimentComparison, "schema_version" | "created_at" | "content_hash">): Promise<ExperimentComparison> {
    await this.initialize(); requireId(record.comparison_id, "comparison_id"); requireId(record.experiment_id, "experiment_id"); requireVersion(record.experiment_version);
    const stored: ExperimentComparison = { ...record, schema_version: RUNTIME_SCHEMA_VERSION, created_at: now(), content_hash: "" }; stored.content_hash = sha256(canonicalJson({ ...stored, content_hash: undefined }));
    this.db.prepare("INSERT INTO runtime_experiment_comparisons(namespace_id, experiment_id, comparison_id, record_json) VALUES (?, ?, ?, ?)").run(this.namespaceId, stored.experiment_id, stored.comparison_id, json(stored)); return stored;
  }
  async listRuntimeExperimentComparisons(experimentId: string): Promise<ExperimentComparison[]> { await this.initialize(); requireId(experimentId, "experiment_id"); return this.recordsRaw<ExperimentComparison>("SELECT record_json FROM runtime_experiment_comparisons WHERE namespace_id = ? AND experiment_id = ? ORDER BY rowid DESC", this.namespaceId, experimentId).map((record) => { this.ensureRuntimeSchema(record); return record; }); }
  async getRuntimeExperimentComparison(experimentId: string, comparisonId: string): Promise<ExperimentComparison> {
    await this.initialize(); requireId(experimentId, "experiment_id"); requireId(comparisonId, "comparison_id"); const row = this.db.prepare("SELECT record_json FROM runtime_experiment_comparisons WHERE namespace_id = ? AND experiment_id = ? AND comparison_id = ?").get(this.namespaceId, experimentId, comparisonId) as JsonRow | undefined;
    if (!row) throw new BittuneError("comparison_not_found", `找不到 Runtime Comparison ${comparisonId}。`); const record = parse<ExperimentComparison>(row.record_json); this.ensureRuntimeSchema(record); return record;
  }

  async saveOptimizationContext(record: Omit<OptimizationContext, "schema_version" | "created_at" | "updated_at" | "content_hash">): Promise<OptimizationContext> {
    await this.initialize(); requireId(record.context_id, "context_id"); requireId(record.experiment_id, "experiment_id"); requireVersion(record.experiment_version);
    const timestamp = now(); const stored: OptimizationContext = { ...record, schema_version: OPTIMIZATION_SCHEMA_VERSION, created_at: timestamp, updated_at: timestamp, content_hash: "" }; stored.content_hash = sha256(canonicalJson({ ...stored, content_hash: undefined }));
    this.db.prepare("INSERT INTO optimization_contexts(namespace_id, context_id, record_json) VALUES (?, ?, ?)").run(this.namespaceId, stored.context_id, json(stored)); return stored;
  }
  async getOptimizationContext(contextId: string): Promise<OptimizationContext> { await this.initialize(); requireId(contextId, "context_id"); const row = this.db.prepare("SELECT record_json FROM optimization_contexts WHERE namespace_id = ? AND context_id = ?").get(this.namespaceId, contextId) as JsonRow | undefined; if (!row) throw new BittuneError("optimization_context_not_found", `找不到 OptimizationContext ${contextId}。`, false); const record = parse<OptimizationContext>(row.record_json); this.ensureOptimizationSchema(record); return record; }
  async listOptimizationContexts(): Promise<OptimizationContext[]> { await this.initialize(); return this.recordsRaw<OptimizationContext>("SELECT record_json FROM optimization_contexts WHERE namespace_id = ? ORDER BY context_id", this.namespaceId).map((record) => { this.ensureOptimizationSchema(record); return record; }); }
  async saveOptimizationCandidate(record: Omit<OptimizationCandidate, "schema_version" | "created_at" | "content_hash">): Promise<OptimizationCandidate> { await this.initialize(); requireId(record.candidate_id, "candidate_id"); requireId(record.context_id, "context_id"); await this.getOptimizationContext(record.context_id); const stored: OptimizationCandidate = { ...record, schema_version: OPTIMIZATION_SCHEMA_VERSION, created_at: now(), content_hash: "" }; stored.content_hash = sha256(canonicalJson({ ...stored, content_hash: undefined })); this.db.prepare("INSERT INTO optimization_candidates(namespace_id, candidate_id, context_id, record_json) VALUES (?, ?, ?, ?)").run(this.namespaceId, stored.candidate_id, stored.context_id, json(stored)); return stored; }
  async getOptimizationCandidate(candidateId: string): Promise<OptimizationCandidate> { await this.initialize(); requireId(candidateId, "candidate_id"); const row = this.db.prepare("SELECT record_json FROM optimization_candidates WHERE namespace_id = ? AND candidate_id = ?").get(this.namespaceId, candidateId) as JsonRow | undefined; if (!row) throw new BittuneError("optimization_candidate_not_found", `找不到 OptimizationCandidate ${candidateId}。`, false); const record = parse<OptimizationCandidate>(row.record_json); this.ensureOptimizationSchema(record); return record; }
  async listOptimizationCandidates(contextId: string): Promise<OptimizationCandidate[]> { await this.initialize(); requireId(contextId, "context_id"); return this.recordsRaw<OptimizationCandidate>("SELECT record_json FROM optimization_candidates WHERE namespace_id = ? AND context_id = ? ORDER BY candidate_id", this.namespaceId, contextId).map((record) => { this.ensureOptimizationSchema(record); return record; }); }
  async reserveOptimizationAttempt(input: Omit<OptimizationAttempt, "schema_version" | "created_at" | "updated_at" | "content_hash" | "state" | "cleanup_status" | "run_ids" | "budget_counted" | "budget_counted_at">): Promise<OptimizationAttempt> {
    await this.initialize(); requireId(input.attempt_id, "attempt_id"); requireId(input.context_id, "context_id"); requireId(input.candidate_id, "candidate_id"); if (new Set(input.selected_gpu_uuids).size !== input.selected_gpu_uuids.length) throw new BittuneError("invalid_input", "selected_gpu_uuids must be unique.", false); const context = await this.getOptimizationContext(input.context_id); if (context.status !== "active") throw new BittuneError("optimization_context_inactive", "OptimizationContext is not active.", false); const candidate = await this.getOptimizationCandidate(input.candidate_id); if (candidate.context_id !== context.context_id) throw new BittuneError("optimization_context_mismatch", "Candidate does not belong to the OptimizationContext.", false);
    const timestamp = now(); const leaseExpiry = Date.parse(input.lease_expires_at); const maximumLeaseSeconds = Math.min(Number(process.env.BITTUNE_OPTIMIZATION_MAX_LEASE_SECONDS ?? 3600), context.budget.max_total_duration_seconds); if (!Number.isFinite(leaseExpiry) || leaseExpiry <= Date.now() || !Number.isFinite(maximumLeaseSeconds) || maximumLeaseSeconds < 1 || leaseExpiry > Date.now() + maximumLeaseSeconds * 1000) throw new BittuneError("invalid_optimization_lease", "lease_expires_at must be future and within the configured optimization lease limit.", false, { maximum_lease_seconds: maximumLeaseSeconds });
    const trials = (await this.listRuntimeExperimentTrials(context.experiment_id)).filter((trial) => trial.experiment_version === context.experiment_version); const spentDuration = trials.reduce((total, trial) => total + trial.evidence_duration_seconds, 0); if (spentDuration >= context.budget.max_total_duration_seconds) throw new BittuneError("budget_exhausted", "OptimizationContext duration budget is exhausted.", false, { spent_duration_seconds: spentDuration, max_total_duration_seconds: context.budget.max_total_duration_seconds });
    const stored: OptimizationAttempt = { ...input, schema_version: OPTIMIZATION_SCHEMA_VERSION, state: "reserved", cleanup_status: "not_required", run_ids: [], budget_counted: true, budget_counted_at: timestamp, created_at: timestamp, updated_at: timestamp, content_hash: "" }; stored.content_hash = sha256(canonicalJson({ ...stored, content_hash: undefined }));
    this.db.exec("BEGIN IMMEDIATE"); try {
      const attempts = (this.db.prepare("SELECT record_json FROM optimization_attempts WHERE namespace_id = ? AND context_id = ?").all(this.namespaceId, input.context_id) as JsonRow[]).map((row) => parse<OptimizationAttempt>(row.record_json));
      if (attempts.some((attempt) => attempt.cleanup_status === "cleanup_pending")) throw new BittuneError("optimization_cleanup_pending", "An earlier Attempt requires cleanup before another Attempt can start.", false);
      const counted = attempts.filter((attempt) => attempt.budget_counted === true || (attempt.budget_counted === undefined && attempt.state !== "reserved")).length;
      if (counted >= context.budget.max_trials) throw new BittuneError("budget_exhausted", "OptimizationContext trial budget is exhausted.", false);
      const failures = attempts.filter((attempt) => attempt.state === "failed").length;
      if (failures >= context.budget.max_failures) throw new BittuneError("budget_exhausted", "OptimizationContext failure budget is exhausted.", false);
      const active = attempts.find((attempt) => attempt.evaluation_key === input.evaluation_key && ["reserved", "starting", "ready", "probing", "benchmarking"].includes(attempt.state));
      if (active) {
        if (Date.parse(active.lease_expires_at) <= Date.now()) throw new BittuneError("optimization_recovery_required", "The previous Attempt lease expired and must be inspected and recovered before retrying.", false);
        throw new BittuneError("optimization_attempt_in_progress", "An Attempt for this evaluation_key is already in progress.", false);
      }
      const completed = attempts.filter((attempt) => attempt.evaluation_key === input.evaluation_key && attempt.state === "measured").length;
      if (completed >= context.required_repetitions && !input.retest_reason) throw new BittuneError("retest_reason_required", "This evaluation_key already has the required repetitions; provide retest_reason to spend another Attempt.", false);
      for (const uuid of input.selected_gpu_uuids) { const lease = this.db.prepare("SELECT lease_id FROM optimization_gpu_leases WHERE namespace_id = ? AND gpu_uuid = ? AND released_at IS NULL AND expires_at > ?").get(this.namespaceId, uuid, timestamp) as { lease_id?: string } | undefined; if (lease?.lease_id) throw new BittuneError("gpu_lease_conflict", `GPU ${uuid} is leased by another Attempt.`, false); }
      this.db.prepare("INSERT INTO optimization_attempts(namespace_id, attempt_id, context_id, evaluation_key, state, record_json) VALUES (?, ?, ?, ?, ?, ?)").run(this.namespaceId, stored.attempt_id, stored.context_id, stored.evaluation_key, stored.state, json(stored)); for (const gpu of stored.selected_gpu_uuids) { const lease: OptimizationGpuLease = { schema_version: OPTIMIZATION_SCHEMA_VERSION, lease_id: stored.lease_id, context_id: stored.context_id, attempt_id: stored.attempt_id, gpu_uuid: gpu, expires_at: stored.lease_expires_at, created_at: timestamp, content_hash: "" }; lease.content_hash = sha256(canonicalJson({ ...lease, content_hash: undefined })); this.db.prepare("INSERT INTO optimization_gpu_leases(namespace_id, lease_id, context_id, attempt_id, gpu_uuid, expires_at, released_at, record_json) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)").run(this.namespaceId, lease.lease_id, lease.context_id, lease.attempt_id, lease.gpu_uuid, lease.expires_at, json(lease)); }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; } return stored;
  }
  async getOptimizationAttempt(attemptId: string): Promise<OptimizationAttempt> { await this.initialize(); requireId(attemptId, "attempt_id"); const row = this.db.prepare("SELECT record_json FROM optimization_attempts WHERE namespace_id = ? AND attempt_id = ?").get(this.namespaceId, attemptId) as JsonRow | undefined; if (!row) throw new BittuneError("optimization_attempt_not_found", `找不到 OptimizationAttempt ${attemptId}。`, false); const record = parse<OptimizationAttempt>(row.record_json); this.ensureOptimizationSchema(record); return record; }
  async listOptimizationAttempts(contextId: string): Promise<OptimizationAttempt[]> { await this.initialize(); requireId(contextId, "context_id"); return this.recordsRaw<OptimizationAttempt>("SELECT record_json FROM optimization_attempts WHERE namespace_id = ? AND context_id = ? ORDER BY attempt_id", this.namespaceId, contextId).map((record) => { this.ensureOptimizationSchema(record); return record; }); }
  async updateOptimizationAttempt(attemptId: string, patch: Partial<Pick<OptimizationAttempt, "state" | "cleanup_status" | "run_ids" | "trial_id" | "failure_code" | "lease_expires_at">>): Promise<OptimizationAttempt> {
    const current = await this.getOptimizationAttempt(attemptId);
    const nextState = patch.state ?? current.state;
    const allowed: Record<OptimizationAttemptState, OptimizationAttemptState[]> = { reserved: ["starting", "cancelled", "abandoned"], starting: ["ready", "failed", "cancelled", "abandoned"], ready: ["probing", "failed", "cancelled", "abandoned"], probing: ["benchmarking", "failed", "cancelled", "abandoned"], benchmarking: ["measured", "failed", "cancelled", "abandoned"], measured: [], failed: [], cancelled: [], abandoned: [] };
    if (nextState !== current.state && !allowed[current.state].includes(nextState)) throw new BittuneError("invalid_attempt_transition", `Attempt cannot transition from ${current.state} to ${nextState}.`, false);
    if (patch.cleanup_status === "cleaned" && !["cancelled", "failed", "abandoned", "measured"].includes(nextState)) throw new BittuneError("invalid_cleanup_transition", "Only terminal Attempts can be marked cleaned.", false);
    const terminal = ["measured", "failed", "cancelled", "abandoned"].includes(nextState);
    const runIds = [...new Set([...current.run_ids, ...(patch.run_ids ?? [])])];
    for (const runId of runIds) this.runRow(runId);
    const context = await this.getOptimizationContext(current.context_id);
    if (patch.lease_expires_at !== undefined) {
      const expiry = Date.parse(patch.lease_expires_at);
      const maximumLeaseSeconds = Math.min(Number(process.env.BITTUNE_OPTIMIZATION_MAX_LEASE_SECONDS ?? 3600), context.budget.max_total_duration_seconds);
      if (!Number.isFinite(expiry) || expiry <= Date.now() || !Number.isFinite(maximumLeaseSeconds) || maximumLeaseSeconds < 1 || expiry > Date.now() + maximumLeaseSeconds * 1000) {
        throw new BittuneError("invalid_optimization_lease", "lease_expires_at must be future and within the configured optimization lease limit.", false, { maximum_lease_seconds: maximumLeaseSeconds });
      }
    }
    if (patch.trial_id) {
      const trial = await this.getRuntimeExperimentTrial(context.experiment_id, patch.trial_id);
      if (trial.experiment_version !== context.experiment_version) throw new BittuneError("evidence_conflict", "Trial does not belong to this OptimizationContext version.", false);
    }
    let cleanupStatus = patch.cleanup_status ?? current.cleanup_status;
    if (terminal && cleanupStatus === "not_required") cleanupStatus = current.state === "reserved" ? "cleaned" : "cleanup_pending";
    const shouldCountBudget = current.state === "reserved" && nextState === "starting" && !current.budget_counted;
    const timestamp = now();
    const updated: OptimizationAttempt = { ...current, ...patch, run_ids: runIds, cleanup_status: cleanupStatus, state: nextState, updated_at: timestamp, ...(shouldCountBudget ? { budget_counted: true, budget_counted_at: timestamp } : {}), ...(terminal ? { completed_at: current.completed_at ?? timestamp } : {}) };
    updated.content_hash = sha256(canonicalJson({ ...updated, content_hash: undefined }));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (shouldCountBudget) {
        const counted = (this.db.prepare("SELECT record_json FROM optimization_attempts WHERE namespace_id = ? AND context_id = ?").all(this.namespaceId, context.context_id) as JsonRow[]).map((row) => parse<OptimizationAttempt>(row.record_json)).filter((attempt) => attempt.budget_counted === true || (attempt.budget_counted === undefined && attempt.state !== "reserved")).length;
        if (counted >= context.budget.max_trials) throw new BittuneError("budget_exhausted", "OptimizationContext trial budget is exhausted.", false);
      }
      this.db.prepare("UPDATE optimization_attempts SET state = ?, record_json = ? WHERE namespace_id = ? AND attempt_id = ?").run(updated.state, json(updated), this.namespaceId, attemptId);
      if (updated.cleanup_status === "cleaned") this.db.prepare("UPDATE optimization_gpu_leases SET released_at = ? WHERE namespace_id = ? AND attempt_id = ? AND released_at IS NULL").run(timestamp, this.namespaceId, attemptId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return updated;
  }

  async startRun(toolName: string, input: unknown, options: StartRunOptions = {}): Promise<{ run_id: string; started_at: string }> {
    await this.initialize();
    const runId = `run-${randomUUID()}`; const startedAt = now(); const sanitizedInput = redact(input);
    this.db.prepare("INSERT INTO runs(run_id, namespace_id, session_id, tool_call_id, parent_run_id, source_run_ids_json, tool_name, started_at, status, provenance_type, input_json, input_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 'estimated', ?, ?)").run(
      runId, this.namespaceId, options.session_id ?? "external", options.tool_call_id ?? "external", options.parent_run_id ?? null, options.source_run_ids ? json([...new Set(options.source_run_ids)]) : null, toolName, startedAt, json(sanitizedInput), sha256(canonicalJson(sanitizedInput)),
    );
    return { run_id: runId, started_at: startedAt };
  }

  async writeArtifact(runId: string, label: string, content: string | Uint8Array, mediaType = "text/plain"): Promise<ArtifactRef> {
    await this.initialize(); this.assertRunExists(runId);
    const bytes = this.sanitizeArtifactContent(content, mediaType);
    const persisted = await this.persistArtifactContent(bytes, mediaType);
    const ref: ArtifactRef = { artifact_id: `artifact-${randomUUID()}`, label, media_type: mediaType, size_bytes: persisted.size_bytes, sha256: persisted.sha256 };
    this.db.prepare("INSERT INTO artifacts(artifact_id, label, sha256, media_type, size_bytes, relative_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(ref.artifact_id, ref.label, ref.sha256, ref.media_type, ref.size_bytes, persisted.relative_path, now());
    this.db.prepare("INSERT INTO run_artifacts(run_id, artifact_id) VALUES (?, ?)").run(runId, ref.artifact_id);
    return ref;
  }

  async ensureArtifactCapacity(): Promise<void> {
    await this.initialize();
    await this.pruneExpiredEvidence();
    const policy = artifactRetentionPolicy();
    if (this.artifactBytes() >= policy.max_total_bytes) {
      throw new BittuneError("artifact_capacity_exhausted", "Artifact storage is at the configured limit; remove or retain fewer unreferenced Runs before starting another benchmark.", false, { ...policy });
    }
  }

  private artifactBytes(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS total_bytes FROM artifacts WHERE artifact_id IN (SELECT DISTINCT run_artifacts.artifact_id FROM run_artifacts JOIN runs ON runs.run_id = run_artifacts.run_id WHERE runs.namespace_id = ?)").get(this.namespaceId) as { total_bytes: number };
    return Number(row.total_bytes) || 0;
  }

  private protectedRunIds(): Set<string> {
    const tables = [
      "runtime_presets", "runtime_capacity_baselines", "runtime_services", "runtime_experiment_specs", "runtime_experiment_trials", "runtime_experiment_comparisons", "runtime_capability_observations",
      "optimization_contexts", "optimization_candidates", "optimization_attempts", "optimization_gpu_leases",
    ];
    const ids = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === "string") {
        if (/^run-[a-f0-9-]{36}$/.test(value)) ids.add(value);
        return;
      }
      if (Array.isArray(value)) for (const item of value) collect(item);
      else if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) collect(item);
    };
    for (const table of tables) {
      const rows = this.db.prepare(`SELECT record_json FROM ${table} WHERE namespace_id = ?`).all(this.namespaceId) as JsonRow[];
      for (const row of rows) collect(parse<unknown>(row.record_json));
    }
    return ids;
  }

  private async pruneExpiredEvidence(): Promise<void> {
    const policy = artifactRetentionPolicy();
    const protectedRuns = this.protectedRunIds();
    const cutoff = new Date(Date.now() - policy.max_age_days * 24 * 60 * 60_000).toISOString();
    const runs = this.db.prepare("SELECT run_id, finished_at FROM runs WHERE namespace_id = ? AND status != 'running' ORDER BY finished_at ASC").all(this.namespaceId) as Array<{ run_id: string; finished_at: string | null }>;
    let total = this.artifactBytes();
    for (const run of runs) {
      if (!run.finished_at || protectedRuns.has(run.run_id)) continue;
      if (run.finished_at > cutoff && total < policy.max_total_bytes) continue;
      const artifacts = this.db.prepare("SELECT artifacts.artifact_id, artifacts.relative_path FROM artifacts JOIN run_artifacts ON run_artifacts.artifact_id = artifacts.artifact_id WHERE run_artifacts.run_id = ?").all(run.run_id) as Array<{ artifact_id: string; relative_path: string }>;
      const orphanedPaths: string[] = [];
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("DELETE FROM runs WHERE run_id = ?").run(run.run_id);
        for (const artifact of artifacts) {
          const remaining = this.db.prepare("SELECT COUNT(*) AS count FROM run_artifacts WHERE artifact_id = ?").get(artifact.artifact_id) as { count: number };
          if (remaining.count !== 0) continue;
          this.db.prepare("DELETE FROM artifacts WHERE artifact_id = ?").run(artifact.artifact_id);
          const sameFile = this.db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE relative_path = ?").get(artifact.relative_path) as { count: number };
          if (sameFile.count === 0) orphanedPaths.push(artifact.relative_path);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      await Promise.all(orphanedPaths.map((path) => unlink(pathInside(this.root, path)).catch(() => undefined)));
      total = this.artifactBytes();
    }
  }

  private sanitizeArtifactContent(content: string | Uint8Array, mediaType: string): Buffer {
    if (typeof content === "string") return Buffer.from(redactText(content), "utf8");
    const bytes = Buffer.from(content);
    return isTextualMediaType(mediaType) ? Buffer.from(redactText(bytes.toString("utf8")), "utf8") : bytes;
  }

  private async persistArtifactContent(bytes: Uint8Array, mediaType: string): Promise<{ sha256: string; size_bytes: number; relative_path: string }> {
    const digest = sha256(bytes); const extension = mediaType === "application/json" || mediaType.endsWith("+json") ? "json" : "log"; const fileName = `${digest.slice("sha256:".length)}.${extension}`; const target = pathInside(this.artifactRoot, fileName);
    await mkdir(this.artifactRoot, { recursive: true, mode: 0o700 });
    if (!existsSync(target)) {
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 });
      try { await rename(temporary, target); } catch (error: unknown) { if (!existsSync(target)) throw error; }
    }
    return { sha256: digest, size_bytes: bytes.length, relative_path: relative(this.root, target) };
  }

  async finishRun(runId: string, args: FinishRunArgs): Promise<void> {
    await this.initialize(); const prior = this.runRow(runId);
    if (prior.status !== "running") throw new BittuneError("state_conflict", `Run ${runId} is already committed.`, false);
    const sanitizedInput = redact(args.input);
    const observation = redact(args.observation) as Observation;
    const observationHash = sha256(canonicalJson(observation));
    const finishedAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE runs SET tool_name = ?, finished_at = ?, status = ?, provenance_type = ?, input_json = ?, input_hash = ?, provider_json = ?, observation_hash = ?, parent_run_id = COALESCE(?, parent_run_id), source_run_ids_json = COALESCE(?, source_run_ids_json) WHERE run_id = ? AND status = 'running'").run(
        args.tool_name, finishedAt, args.status, args.provenance_type, json(sanitizedInput), sha256(canonicalJson(sanitizedInput)), args.provider ? json(args.provider) : null, observationHash, args.parent_run_id ?? null, args.source_run_ids ? json([...new Set(args.source_run_ids)]) : null, runId,
      );
      this.db.prepare("INSERT INTO observations(run_id, summary, observation_json) VALUES (?, ?, ?)").run(runId, observation.summary, json(observation));
      for (const artifact of args.artifacts) this.db.prepare("INSERT OR IGNORE INTO run_artifacts(run_id, artifact_id) VALUES (?, ?)").run(runId, artifact.artifact_id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async cancelRun(runId: string, input: unknown, message = "Operation cancelled."): Promise<void> {
    const row = this.runRow(runId); if (row.status !== "running") return;
    const observation: Observation = { ok: false, summary: message, provenance_type: "estimated", measured_at: now(), run_id: runId, warnings: [], artifacts: [], error: { code: "cancelled", message, retryable: true } };
    await this.finishRun(runId, { tool_name: row.tool_name, started_at: row.started_at, status: "cancelled", provenance_type: "estimated", input, artifacts: [], observation });
  }

  async getRun(runId: string): Promise<{ manifest: RunManifest; observation: Observation }> {
    await this.initialize(); const row = this.runRow(runId); const observationRow = this.db.prepare("SELECT observation_json FROM observations WHERE run_id = ?").get(runId) as { observation_json: string } | undefined;
    if (!observationRow || !row.finished_at || !row.observation_hash) throw new BittuneError("run_not_found", `找不到完整的 Run Record ${runId}。`);
    const artifacts = this.runArtifacts(runId);
    const manifest: RunManifest = { schema_version: RUNTIME_SCHEMA_VERSION, run_id: row.run_id, namespace_id: row.namespace_id, session_id: row.session_id, tool_call_id: row.tool_call_id, ...(row.parent_run_id ? { parent_run_id: row.parent_run_id } : {}), ...(row.source_run_ids_json ? { source_run_ids: parse<string[]>(row.source_run_ids_json) } : {}), tool_name: row.tool_name, started_at: row.started_at, finished_at: row.finished_at, status: row.status, provenance_type: row.provenance_type, input_hash: row.input_hash, input: parse(row.input_json), ...(row.provider_json ? { provider: parse(row.provider_json) } : {}), observation_hash: row.observation_hash, artifacts };
    const observation = parse<Observation>(observationRow.observation_json);
    if (sha256(canonicalJson(observation)) !== manifest.observation_hash) throw new BittuneError("state_conflict", `Run ${runId} observation hash mismatch.`, false);
    return { manifest, observation };
  }

  async listRuns(filter: { tool_name?: string; status?: Exclude<RunStatus, "running" | "incomplete">; limit?: number } = {}): Promise<RunManifest[]> {
    await this.initialize();
    const clauses = ["namespace_id = ?", "status != 'running'"]; const params: Array<string | number | null> = [this.namespaceId];
    if (filter.tool_name) { clauses.push("tool_name = ?"); params.push(filter.tool_name); }
    if (filter.status) { clauses.push("status = ?"); params.push(filter.status); }
    const limit = Math.min(filter.limit ?? 50, 100);
    const rows = this.db.prepare(`SELECT * FROM runs WHERE ${clauses.join(" AND ")} ORDER BY finished_at DESC LIMIT ?`).all(...params, limit) as unknown as RunRow[];
    const records: RunManifest[] = [];
    for (const row of rows) {
      if (!row.finished_at || !row.observation_hash) continue;
      records.push({ schema_version: RUNTIME_SCHEMA_VERSION, run_id: row.run_id, namespace_id: row.namespace_id, session_id: row.session_id, tool_call_id: row.tool_call_id, ...(row.parent_run_id ? { parent_run_id: row.parent_run_id } : {}), ...(row.source_run_ids_json ? { source_run_ids: parse<string[]>(row.source_run_ids_json) } : {}), tool_name: row.tool_name, started_at: row.started_at, finished_at: row.finished_at, status: row.status, provenance_type: row.provenance_type, input_hash: row.input_hash, input: parse(row.input_json), ...(row.provider_json ? { provider: parse(row.provider_json) } : {}), observation_hash: row.observation_hash, artifacts: this.runArtifacts(row.run_id) });
    }
    return records;
  }

  async readArtifact(runId: string, artifactId: string, offsetBytes: number, maxBytes: number): Promise<{ text: string; total_bytes: number; truncated: boolean }> {
    await this.initialize();
    if (!/^run-[a-f0-9-]{36}$/.test(runId)) throw new BittuneError("invalid_input", "run_id is invalid.", false);
    if (!/^artifact-[a-f0-9-]{36}$/.test(artifactId)) throw new BittuneError("invalid_input", "artifact_id is invalid.", false);
    if (!Number.isInteger(offsetBytes) || offsetBytes < 0 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536) throw new BittuneError("invalid_input", "Artifact 读取范围不合法。", false);
    const row = this.db.prepare("SELECT artifacts.sha256, artifacts.relative_path, artifacts.size_bytes FROM artifacts JOIN run_artifacts ON run_artifacts.artifact_id = artifacts.artifact_id JOIN runs ON runs.run_id = run_artifacts.run_id WHERE run_artifacts.run_id = ? AND artifacts.artifact_id = ? AND runs.namespace_id = ?").get(runId, artifactId, this.namespaceId) as { sha256: string; relative_path: string; size_bytes: number } | undefined;
    if (!row) throw new BittuneError("artifact_not_found", `Run ${runId} 中没有 Artifact ${artifactId}。`);
    const path = pathInside(this.root, row.relative_path); const bytes = await readFile(path);
    if (sha256(bytes) !== row.sha256) throw new BittuneError("state_conflict", `Artifact ${artifactId} hash mismatch.`, false);
    return { text: bytes.subarray(offsetBytes, offsetBytes + maxBytes).toString("utf8"), total_bytes: bytes.length, truncated: offsetBytes + maxBytes < bytes.length };
  }

  private createSchema(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS namespaces (namespace_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY, namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id), session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
        parent_run_id TEXT, source_run_ids_json TEXT, tool_name TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','incomplete')), provenance_type TEXT NOT NULL,
        input_json TEXT NOT NULL, input_hash TEXT NOT NULL, provider_json TEXT, observation_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_namespace_finished ON runs(namespace_id, finished_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(namespace_id, session_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS observations (run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE, summary TEXT NOT NULL, observation_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (artifact_id TEXT PRIMARY KEY, label TEXT NOT NULL, sha256 TEXT NOT NULL, media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, relative_path TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_artifacts (run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id), PRIMARY KEY(run_id, artifact_id));
      CREATE TABLE IF NOT EXISTS runtime_presets (namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id), preset_id TEXT NOT NULL, version TEXT NOT NULL, version_number INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(namespace_id, preset_id, version));
      CREATE TABLE IF NOT EXISTS runtime_capacity_baselines (namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id), baseline_id TEXT NOT NULL, version TEXT NOT NULL, version_number INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(namespace_id, baseline_id, version));
      CREATE TABLE IF NOT EXISTS runtime_services (namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id), instance_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(namespace_id, instance_id));
      CREATE TABLE IF NOT EXISTS runtime_experiment_specs (namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id), experiment_id TEXT NOT NULL, version TEXT NOT NULL, version_number INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(namespace_id, experiment_id, version));
      CREATE TABLE IF NOT EXISTS runtime_experiment_trials (namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id), experiment_id TEXT NOT NULL, trial_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(namespace_id, experiment_id, trial_id));
      CREATE TABLE IF NOT EXISTS runtime_experiment_comparisons (namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id), experiment_id TEXT NOT NULL, comparison_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(namespace_id, experiment_id, comparison_id));
      CREATE TABLE IF NOT EXISTS runtime_capability_observations (namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id), capability_id TEXT NOT NULL, runtime_kind TEXT NOT NULL, runtime_image_digest TEXT NOT NULL, runtime_image_id TEXT NOT NULL, observed_at TEXT NOT NULL, expires_at TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(namespace_id, capability_id));
      CREATE INDEX IF NOT EXISTS idx_runtime_capability_observation_identity ON runtime_capability_observations(namespace_id, runtime_kind, runtime_image_digest, runtime_image_id, expires_at DESC);
      CREATE TABLE IF NOT EXISTS optimization_contexts (namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id), context_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(namespace_id, context_id));
      CREATE TABLE IF NOT EXISTS optimization_candidates (namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id), candidate_id TEXT NOT NULL, context_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(namespace_id, candidate_id));
      CREATE TABLE IF NOT EXISTS optimization_attempts (namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id), attempt_id TEXT NOT NULL, context_id TEXT NOT NULL, evaluation_key TEXT NOT NULL, state TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(namespace_id, attempt_id));
      CREATE INDEX IF NOT EXISTS idx_optimization_attempts_evaluation ON optimization_attempts(namespace_id, context_id, evaluation_key, state);
      CREATE TABLE IF NOT EXISTS optimization_gpu_leases (namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id), lease_id TEXT NOT NULL, context_id TEXT NOT NULL, attempt_id TEXT NOT NULL, gpu_uuid TEXT NOT NULL, expires_at TEXT NOT NULL, released_at TEXT, record_json TEXT NOT NULL, PRIMARY KEY(namespace_id, lease_id, gpu_uuid));
      CREATE INDEX IF NOT EXISTS idx_optimization_gpu_leases_active ON optimization_gpu_leases(namespace_id, gpu_uuid, released_at, expires_at);
      CREATE TABLE IF NOT EXISTS tool_invocation_audit (id TEXT PRIMARY KEY, namespace_id TEXT NOT NULL REFERENCES namespaces(namespace_id), session_id TEXT, tool_call_id TEXT, tool_name TEXT NOT NULL, occurred_at TEXT NOT NULL, detail_json TEXT NOT NULL);
    `);
  }

  private recordsRaw<T>(sql: string, ...params: Array<string | number | null>): T[] { return (this.db.prepare(sql).all(...params) as unknown as JsonRow[]).map((row) => parse<T>(row.record_json)); }
  private ensureRuntimeSchema(record: { schema_version?: number }): void { if (record.schema_version !== RUNTIME_SCHEMA_VERSION) throw new BittuneError("state_schema_mismatch", "Runtime record must use the current schema.", false); }
  private ensureOptimizationSchema(record: { schema_version?: number }): void { if (record.schema_version !== OPTIMIZATION_SCHEMA_VERSION) throw new BittuneError("state_schema_mismatch", "Optimization record uses an unsupported schema.", false); }
  private runRow(runId: string): RunRow { if (!/^run-[a-f0-9-]{36}$/.test(runId)) throw new BittuneError("invalid_input", "run_id is invalid.", false); const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ? AND namespace_id = ?").get(runId, this.namespaceId) as RunRow | undefined; if (!row) throw new BittuneError("run_not_found", `找不到 Run Record ${runId}。`); return row; }
  private assertRunExists(runId: string): void { this.runRow(runId); }
  private runArtifacts(runId: string): ArtifactRef[] { return this.db.prepare("SELECT artifacts.artifact_id, artifacts.media_type, artifacts.size_bytes, artifacts.sha256, artifacts.label FROM artifacts JOIN run_artifacts ON run_artifacts.artifact_id = artifacts.artifact_id WHERE run_artifacts.run_id = ? ORDER BY artifacts.created_at").all(runId) as unknown as ArtifactRef[]; }
  private versionNumber(value: string): number { return Number(value.slice(1)); }
  private async runtimeVersionedWrite<T>(kind: "runtime-presets" | "runtime-capacity-baselines" | "runtime-experiment-specs", id: string, operation: (version: string) => Promise<T>, expectedParent?: string): Promise<T> {
    const table = kind.replaceAll("-", "_");
    const idColumn = kind === "runtime-experiment-specs" ? "experiment_id" : kind === "runtime-presets" ? "preset_id" : "baseline_id";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const parent = this.db.prepare(`SELECT version FROM ${table} WHERE namespace_id = ? AND ${idColumn} = ? ORDER BY version_number DESC LIMIT 1`).get(this.namespaceId, id) as { version: string } | undefined;
      if (expectedParent !== undefined && parent?.version !== expectedParent) throw new BittuneError("state_conflict", `Expected parent version ${expectedParent}, current version is ${parent?.version ?? "none"}.`, true);
      const result = await operation(`v${(parent ? this.versionNumber(parent.version) : 0) + 1}`);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async resolveModelSnapshot(preset: DeploymentPreset): Promise<{ cache_root: string; host_snapshot_path: string } | undefined> {
    for (const root of this.hfCacheRoots) {
      for (const path of this.snapshotPathsAt(root, preset)) {
        if (await this.snapshotExistsAt(root, path)) return { cache_root: root, host_snapshot_path: path };
      }
    }
    return undefined;
  }
  async modelSnapshotPath(preset: DeploymentPreset): Promise<string> { return (await this.resolveModelSnapshot(preset))?.host_snapshot_path ?? this.snapshotPathAt(this.hfCacheRoot, preset); }
  async snapshotExists(preset: DeploymentPreset): Promise<boolean> { return (await this.resolveModelSnapshot(preset)) !== undefined; }
  private snapshotPathAt(root: string, preset: DeploymentPreset): string { return join(root, "hub", `models--${preset.model_id.replace("/", "--")}`, "snapshots", preset.model_revision); }
  private snapshotPathsAt(root: string, preset: DeploymentPreset): string[] {
    const modelDirectory = `models--${preset.model_id.replace("/", "--")}`;
    return [join(root, "hub", modelDirectory, "snapshots", preset.model_revision), join(root, modelDirectory, "snapshots", preset.model_revision)];
  }
  private async snapshotExistsAt(cacheRoot: string, path: string): Promise<boolean> {
    try {
      const resolvedRoot = await realpath(cacheRoot);
      const resolvedSnapshot = await realpath(path);
      if (!resolvedPathIsWithin(resolvedRoot, resolvedSnapshot) || !(await stat(resolvedSnapshot)).isDirectory()) return false;
      const entries = await readdir(resolvedSnapshot);
      for (const name of entries) {
        if (!/\.(safetensors|bin|pt|pth|gguf)$/i.test(name)) continue;
        try {
          const resolvedWeight = await realpath(join(resolvedSnapshot, name));
          if (resolvedPathIsWithin(resolvedRoot, resolvedWeight) && (await stat(resolvedWeight)).isFile()) return true;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return false;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  }
