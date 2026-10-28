"""Metric-only export of EvalScope's request database; no payload decoding."""

import hashlib
import json
import math
import re
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

from bittune_core.contracts import ContractError
from bittune_core.runs import ManagedRun
from bittune_core.measurement import MeasurementBuilder

_COLUMNS = (
    "request_id", "success", "is_stream", "start_time", "completed_time", "latency",
    "first_chunk_latency", "time_per_output_token", "prompt_tokens", "completion_tokens",
    "inter_token_latencies",
)


def _count(metrics: dict[str, Any], kind: str) -> int | None:
    pattern = {"total": r"(total|all)", "success": r"success(ful)?", "failed": r"failed"}[kind]
    for key, value in metrics.items():
        if re.fullmatch(pattern + r"[\s_]*requests?", key.rsplit(".", 1)[-1], re.I):
            if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0 and int(value) == value:
                return int(value)
    return None


def collect_request_evidence(
    output_dir: Path, run: ManagedRun, expected_requests: int, metrics: dict[str, Any],
    *, expected_input_tokens: int | None = None, expected_output_tokens: int | None = None, acceptance=None, source_root: Path | None = None,
) -> dict[str, Any]:
    builder = MeasurementBuilder(acceptance)
    paths = sorted(output_dir.rglob("benchmark_data.db"))
    metadata: dict[str, Any] = {
        "schema_version": 1, "status": "absent", "row_count": 0,
        "success_count": 0, "failed_count": 0, "artifact_ids": [],
        "percentile_algorithm": "linear_n_minus_1_v1",
        "timing_source": "EvalScope seconds; ITL is response-chunk intervals, not proven token intervals",
        "shape_mismatch_count": 0,
        "expected_input_tokens": expected_input_tokens,
        "expected_output_tokens": expected_output_tokens,
        "omitted_columns": ["request", "response_messages", "max_gpu_memory_cost"],
    }
    samples: dict[str, list[float]] = {}
    if not paths:
        return {"metadata": metadata, "samples": samples, "measurement": builder.finish(samples, metadata["status"])}
    metadata["status"] = "invalid"
    errors: list[str] = []
    if len(paths) != 1:
        errors.append("Expected one request database for this single workload")
    else:
        path = paths[0]
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
        metadata["source_path"] = str(path.relative_to(source_root or output_dir))
        metadata["source_sha256"] = "sha256:" + digest.hexdigest()
        rows: list[dict[str, Any]] = []
        chunk_bytes = 0

        def flush() -> None:
            nonlocal rows, chunk_bytes
            if rows:
                ref = run.artifact("evalscope-request-metrics", json.dumps({
                    "schema_version": 1, "source_path": metadata["source_path"],
                    "source_sha256": metadata["source_sha256"], "units": "seconds",
                    "records": rows,
                }, ensure_ascii=False, allow_nan=False), "application/json")
                metadata["artifact_ids"].append(ref["artifact_id"])
                rows, chunk_bytes = [], 0

        try:
            with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
                connection.row_factory = sqlite3.Row
                cursor = connection.execute("SELECT rowid AS row_id, " + ", ".join(_COLUMNS) + ", request AS request_json FROM result ORDER BY rowid")
                for row in cursor:
                    record = dict(row)
                    raw_request = record.pop("request_json")
                    intervals = json.loads(record["inter_token_latencies"])
                    if not isinstance(intervals, list) or any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or v < 0 for v in intervals):
                        raise ValueError("Invalid inter_token_latencies")
                    # Preserve provider seconds and nulls; never unpickle response_messages.
                    record["inter_token_latencies"] = intervals
                    if record["success"] not in (0, 1) or record["is_stream"] not in (0, 1):
                        raise ValueError("Invalid success/is_stream flag")
                    for key in _COLUMNS[3:-1]:
                        value = record[key]
                        if value is not None and (not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0):
                            raise ValueError(f"Invalid {key}")
                    for key in ("prompt_tokens", "completion_tokens"):
                        if record[key] is not None and int(record[key]) != record[key]:
                            raise ValueError(f"Invalid {key}")
                    if record["success"] and record["latency"] is None:
                        raise ValueError("Successful request has no latency")
                    builder.observe(record, raw_request)
                    rows.append(record)
                    chunk_bytes += len(json.dumps(record, ensure_ascii=False).encode("utf-8"))
                    metadata["row_count"] += 1
                    metadata["success_count" if record["success"] else "failed_count"] += 1
                    if record["success"]:
                        if ((expected_input_tokens is not None and record["prompt_tokens"] != expected_input_tokens) or
                                (expected_output_tokens is not None and record["completion_tokens"] != expected_output_tokens)):
                            metadata["shape_mismatch_count"] += 1
                        samples.setdefault("e2e_latency_ms", []).append(record["latency"] * 1000)
                        if record["is_stream"]:
                            for raw, name in (("first_chunk_latency", "ttft_ms"), ("time_per_output_token", "tpot_ms")):
                                if record[raw] is not None and (name != "tpot_ms" or (record["completion_tokens"] or 0) > 1):
                                    samples.setdefault(name, []).append(record[raw] * 1000)
                            samples.setdefault("itl_ms", []).extend(value * 1000 for value in intervals)
                    if chunk_bytes >= 1024 * 1024 or len(rows) >= 1000:
                        flush()
                flush()
        except (sqlite3.Error, ValueError, TypeError, ContractError) as error:
            errors.append(f"Request metric export failed: {error}")
        for kind, field in (("total", "row_count"), ("success", "success_count"), ("failed", "failed_count")):
            count = _count(metrics, kind)
            if count is None or count != metadata[field]:
                errors.append(f"Provider {kind} count does not match request rows")
        if metadata["row_count"] != expected_requests:
            errors.append("Request rows do not match planned request_count")
    if metadata["shape_mismatch_count"]:
        errors.append("Actual token counts do not match the fixed workload")
    if not errors:
        metadata["status"] = "complete"
    else:
        metadata["errors"] = errors
        samples = {}
    measurement = builder.finish(samples, metadata["status"])
    run.artifact("evalscope-request-evidence", json.dumps(metadata, ensure_ascii=False), "application/json")
    return {"metadata": metadata, "samples": samples, "measurement": measurement}
