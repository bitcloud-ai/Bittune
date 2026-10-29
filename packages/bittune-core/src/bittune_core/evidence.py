"""Generic-tool evidence intake and the inspect_records handlers.

The Runtime executes generic tools (bash/read/edit/write) itself and submits
their raw evidence through the Core's append-only intake path: it writes one
JSON evidence record into the per-session staging directory and asks the Core
to ingest it. The Core redacts input and output, creates the Run and
Artifacts with hashes, and removes the staging file only after a successful
ingest. Evidence never becomes a Canonical Fact on its own.
"""

import json
from pathlib import Path
from typing import Any

from bittune_core.contracts import GENERIC_TOOL_NAMES, ContractError
from bittune_core.redaction import redact
from bittune_core.store import CoreStore, utc_now

_MAX_OUTPUTS = 8


def _parse_evidence_file(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as error:
        raise ContractError("not_found", f"Staging file {path.name} cannot be read.", {"filename": path.name}) from error
    try:
        record = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ContractError("invalid_input", f"Staging file {path.name} is not valid JSON.", {"filename": path.name}) from error
    if not isinstance(record, dict):
        raise ContractError("invalid_input", f"Staging file {path.name} must contain a JSON object.", {"filename": path.name})
    return record


def _validate_evidence_record(record: dict[str, Any]) -> None:
    tool_name = record.get("tool_name")
    if tool_name not in GENERIC_TOOL_NAMES:
        raise ContractError("invalid_input", "tool_name must be one of bash/read/edit/write.", {"tool_name": tool_name})
    status = record.get("status")
    if status not in ("completed", "failed", "cancelled"):
        raise ContractError("invalid_input", "status must be completed, failed or cancelled.", {"status": status})
    if not isinstance(record.get("input"), dict):
        raise ContractError("invalid_input", "input must be an object.", {})
    outputs = record.get("outputs")
    if outputs is None:
        return
    if not isinstance(outputs, list) or len(outputs) > _MAX_OUTPUTS:
        raise ContractError("invalid_input", f"outputs must be a list of at most {_MAX_OUTPUTS} items.", {})
    for item in outputs:
        if not isinstance(item, dict):
            raise ContractError("invalid_input", "Each output must be an object with label, content and media_type.", {})
        if not isinstance(item.get("content"), str):
            raise ContractError("invalid_input", "Each output needs a string content.", {})
        if not isinstance(item.get("label", ""), str) or not isinstance(item.get("media_type"), str) or not item.get("media_type"):
            raise ContractError("invalid_input", "Each output needs a string label and a non-empty media_type.", {})


def ingest_evidence(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    session_id = context["session_id"]
    cancellation = context["cancellation"]
    filename = params.get("staging_file")
    if not isinstance(filename, str) or not filename:
        raise ContractError(
            "invalid_input",
            "staging_file is required.",
            {},
            remediation="Write the evidence record into the per-session staging directory and pass its plain filename.",
        )
    path = store.staging_path(session_id, filename)
    if not path.is_file():
        raise ContractError("not_found", f"Staging file {filename} does not exist in this session.", {"filename": filename})
    record = _parse_evidence_file(path)
    _validate_evidence_record(record)
    tool_name = record["tool_name"]
    status = record["status"]
    input_value = record["input"]
    if context.get('task_scope') is not None:
        input_value = {**input_value, '_task_scope_hash': context['task_scope'].scope_hash}
    summary = record.get("summary") if isinstance(record.get("summary"), str) else ""
    error = record.get("error") if isinstance(record.get("error"), dict) else None
    run_id, _ = store.start_run(tool_name, "generic", input_value, session_id)
    artifact_refs: list[dict[str, Any]] = []
    emit_progress = context["emit_progress"]
    try:
        outputs = record.get("outputs") or []
        for index, item in enumerate(outputs):
            cancellation.raise_if_requested()
            emit_progress(f"persisting output {index + 1}/{len(outputs)}")
            ref = store.write_artifact(run_id, item["label"], item["content"], item.get("media_type", "text/plain"))
            artifact_refs.append(ref)
        run_status = "cancelled" if status == "cancelled" else ("failed" if status == "failed" else "completed")
        observation: dict[str, Any] = {
            "summary": summary,
            "warnings": [],
            "artifact_refs": artifact_refs,
            **({"error": error} if error else {}),
        }
        store.finish_run(run_id, run_status, observation)
        path.unlink(missing_ok=True)
        return {"run_id": run_id, "status": run_status, "tool_name": tool_name, "artifact_refs": redact(artifact_refs)}
    except ContractError as ingest_error:
        if ingest_error.code == "cancelled":
            store.cancel_run(run_id)
        else:
            store.finish_run(
                run_id,
                "failed",
                {"summary": ingest_error.message, "warnings": [], "artifact_refs": artifact_refs, "error": ingest_error.to_result()},
            )
        raise


def inspect_records(params: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    store: CoreStore = context["store"]
    kind = params.get("kind")
    if not isinstance(kind, str) or not kind:
        raise ContractError(
            "invalid_input",
            "kind is required.",
            {},
            remediation="Kinds: run, artifact, hardware_snapshot, deployment_plan, service_instance, benchmark_result, experiment, report.",
        )
    if kind == "run":
        record_id = params.get("id")
        if record_id:
            return store.get_run(record_id)
        tool_name = params.get("tool_name") if isinstance(params.get("tool_name"), str) else None
        status = params.get("status") if isinstance(params.get("status"), str) else None
        return {"runs": store.list_runs(limit=_limit(params), tool_name=tool_name, status=status)}
    if kind == "artifact":
        record_id = params.get("id")
        if not record_id:
            raise ContractError("invalid_input", "kind=artifact requires id.", {})
        return store.read_artifact_excerpt(
            record_id,
            offset_bytes=params.get("offset_bytes", 0),
            max_bytes=params.get("max_bytes", 4096),
        )
    if kind in ("hardware_snapshot", "deployment_plan", "service_instance", "benchmark_result", "experiment", "report", "suite_result", "correctness_result", "cache_pair_result", "pd_estimate"):
        record_id = params.get("id")
        if record_id:
            return store.get_fact(kind, record_id)
        raw_filters = {
            "hardware_snapshot_id": params.get("hardware_snapshot_id"),
            "model_id": params.get("model_id"),
            "model_revision": params.get("model_revision"),
            "runtime_kind": params.get("runtime_kind"),
            "workload_hash": params.get("workload_hash"),
            "service_instance_id": params.get("service_instance_id"),
            "ownership": params.get("ownership"),
            "endpoint": params.get("endpoint"),
            "plan_id": params.get("plan_id"),
            "status": params.get("status"),
            "profile_id": params.get("profile_id"),
        }
        filters = {key: value for key, value in raw_filters.items() if value is not None}
        scope = context.get("task_scope")
        allowed_ids = scope.allowed_record_ids(kind) if scope else None
        return {"records": store.list_facts(kind, limit=_limit(params), allowed_ids=allowed_ids, **filters)}
    raise ContractError("invalid_input", f"Unknown record kind {kind}.", {"kind": kind})


def _limit(params: dict[str, Any]) -> int:
    value = params.get("limit", 20)
    if not isinstance(value, int) or isinstance(value, bool):
        raise ContractError("invalid_input", "limit must be an integer.", {"limit": value})
    return value
