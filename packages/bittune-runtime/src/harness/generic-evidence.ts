import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResultEvent } from "../core/extensions/types.ts";
import { CoreClient, CoreError } from "./core-client.ts";

/**
 * Generic-tool evidence capture: after read/bash/edit/write completes the
 * Runtime summarizes the call, caps the raw material (Bash keeps its bounded
 * full output; file tools never auto-copy arbitrary file content), stages one
 * evidence record inside `core/staging/<session>/` and asks the Core to
 * ingest it. The result hook waits for persisted source IDs before returning
 * to the Agent; a Core outage leaves a warning and the staged file.
 */

export const EVIDENCE_OUTPUT_CAP_BYTES = 256 * 1024;
const RESULT_SUMMARY_CAP_CHARS = 1200;
const RESULT_OUTPUT_CAP_BYTES = 64 * 1024;

export interface EvidenceOutput {
	label: string;
	content: string;
	media_type: string;
}

export type GenericToolName = "bash" | "read" | "edit" | "write";
export type GenericToolResultEvent = Extract<ToolResultEvent, { toolName: GenericToolName }>;

export interface EvidenceRecord {
	tool_name: GenericToolName;
	status: "completed" | "failed" | "cancelled";
	summary: string;
	input: Record<string, unknown>;
	error?: { code: string; message: string };
	outputs: EvidenceOutput[];
}

function firstErrorLine(event: ToolResultEvent): string {
	for (const item of event.content) {
		if (item.type === "text" && item.text) return item.text.trim().split(/\r?\n/)[0]!.slice(0, 300);
	}
	return "未说明原因。";
}

function resultText(event: ToolResultEvent): string {
	return event.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function capText(value: string, bytes: number): string {
	const buffer = Buffer.from(value, "utf8");
	if (buffer.length <= bytes) return value;
	return buffer.subarray(0, bytes).toString("utf8");
}

function capFile(path: string, bytes: number): string | undefined {
	if (!existsSync(path)) return undefined;
	return capText(readFileSync(path).toString("utf8"), bytes);
}

/** Bash keeps its root material: the result the model saw plus the bounded
 * full output the executor kept on disk. */
export function bashEvidenceOutputs(event: Extract<ToolResultEvent, { toolName: "bash" }>): EvidenceOutput[] {
	const outputs: EvidenceOutput[] = [];
	const result = capText(resultText(event), RESULT_OUTPUT_CAP_BYTES);
	if (result) outputs.push({ label: "result", content: result, media_type: "text/plain" });
	const fullPath = event.details?.fullOutputPath;
	if (fullPath) {
		const full = capFile(fullPath, EVIDENCE_OUTPUT_CAP_BYTES);
		if (full !== undefined) outputs.push({ label: "full-output", content: full, media_type: "text/plain" });
	}
	return outputs;
}

export function buildEvidenceFromResult(event: GenericToolResultEvent, status: "completed" | "failed" | "cancelled"): EvidenceRecord {
	return {
		tool_name: event.toolName,
		status,
		summary: capText(event.isError ? firstErrorLine(event) : resultText(event), RESULT_SUMMARY_CAP_CHARS),
		input: event.input as Record<string, unknown>,
		...(event.isError ? { error: { code: "tool_error", message: firstErrorLine(event) } } : {}),
		outputs: event.toolName === "bash" ? bashEvidenceOutputs(event) : [],
	};
}

export interface EvidenceSubmitter {
	client: CoreClient;
	coreHome: string;
	sessionId: string;
	warn: (message: string) => void;
}

export type EvidenceStager = Pick<EvidenceSubmitter, "coreHome" | "sessionId" | "warn">;

export interface EvidenceReceipt {
	run_id: string;
	status: "completed" | "failed" | "cancelled";
	tool_name: GenericToolName;
	artifact_refs: Array<{ artifact_id: string; [key: string]: unknown }>;
}

const ingestTails = new WeakMap<object, Promise<EvidenceReceipt | undefined>>();

/** Writes the evidence record into the session staging dir. Does not talk to Core. */
export function stageEvidence(evidence: EvidenceRecord, stager: EvidenceStager): string | undefined {
	const staging = join(stager.coreHome, "staging", stager.sessionId);
	try {
		mkdirSync(staging, { recursive: true });
		const filename = `ev-${randomUUID()}.json`;
		writeFileSync(join(staging, filename), JSON.stringify(evidence), "utf8");
		return filename;
	} catch (error) {
		stager.warn(`evidence staging unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

async function waitForCoreIdle(client: CoreClient): Promise<void> {
	if (typeof client.whenIdle === "function") await client.whenIdle();
}

function isCoreBusy(error: unknown): boolean {
	return error instanceof CoreError && error.code === "core_busy";
}

async function ingestStagedEvidence(filename: string, submitter: EvidenceSubmitter): Promise<EvidenceReceipt | undefined> {
	for (;;) {
		try {
			await waitForCoreIdle(submitter.client);
			return await submitter.client.request<EvidenceReceipt>("ingest_evidence", { staging_file: filename }, { sessionId: submitter.sessionId });
		} catch (error) {
			if (isCoreBusy(error)) continue;
			const message = error instanceof Error ? error.message : String(error);
			submitter.warn(`通用工具证据未被保存（staging ${filename} 已保留）：${message}`);
			return;
		}
	}
}

function enqueueIngest(filename: string, submitter: EvidenceSubmitter): Promise<EvidenceReceipt | undefined> {
	const previous = ingestTails.get(submitter.client) ?? Promise.resolve();
	const next = previous.then(() => ingestStagedEvidence(filename, submitter));
	ingestTails.set(submitter.client, next);
	return next;
}

/** Child scouts stage during the tool; the parent flushes after the scout returns. */
export async function ingestStagedEvidenceSerial(
	filenames: readonly string[],
	submitter: EvidenceSubmitter,
): Promise<void> {
	for (const filename of filenames) {
		await enqueueIngest(filename, submitter);
	}
}

/** Parent generic tools wait on the same intake queue and return persisted IDs.
 * Failure leaves the tool output intact, with no fabricated evidence receipt. */
export function submitEvidence(evidence: EvidenceRecord, submitter: EvidenceSubmitter): Promise<EvidenceReceipt | undefined> {
	const filename = stageEvidence(evidence, submitter);
	if (!filename) return Promise.resolve(undefined);
	return enqueueIngest(filename, submitter);
}
