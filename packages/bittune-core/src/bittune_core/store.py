"""The local Store: SQLite + artifact files, the only writer in the system.

`CoreStore` owns the eight business tables, the artifact directory and the
per-session staging directory. Runs and Artifacts make up the execution
ledger; Canonical Facts are immutable JSON payloads with a content hash and a
`provenance-v1` source label. Query columns mirror the design contract so
`inspect_records` can find facts by hardware, model, runtime kind, workload
hash, service instance and ownership without scanning payloads.

The Core is the only process that opens `bittune.db`; the Node Runtime never
touches SQLite and submits evidence through `staging/`.
"""

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from bittune_core.contracts import (
    ARTIFACT_ID,
    PROVENANCE_VALUES,
    RUN_ID,
    RUN_STATUSES,
    ContractError,
    canonical_json,
    sha256_bytes,
    sha256_canonical,
)
from bittune_core.redaction import redact, redact_text

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  action_path TEXT NOT NULL CHECK(action_path IN ('generic', 'managed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','interrupted')),
  input_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  observation_json TEXT,
  observation_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_finished ON runs(finished_at);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, started_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(run_id),
  label TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);

CREATE TABLE IF NOT EXISTS hardware_snapshots (
  hardware_snapshot_id TEXT PRIMARY KEY,
  source_run_id TEXT NOT NULL,
  host_id TEXT,
  observed_at TEXT,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployment_plans (
  plan_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('draft','frozen')),
  hardware_snapshot_id TEXT,
  model_id TEXT,
  model_revision TEXT,
  runtime_kind TEXT,
  source_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_model ON deployment_plans(model_id, model_revision);

CREATE TABLE IF NOT EXISTS service_instances (
  service_instance_id TEXT PRIMARY KEY,
  plan_id TEXT,
  ownership TEXT NOT NULL CHECK(ownership IN ('managed','observed','external')),
  runtime_kind TEXT,
  model_id TEXT,
  model_revision TEXT,
  endpoint TEXT,
  last_observed_at TEXT,
  source_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_services_ownership ON service_instances(ownership);

CREATE TABLE IF NOT EXISTS benchmark_results (
  benchmark_result_id TEXT PRIMARY KEY,
  service_instance_id TEXT,
  workload_hash TEXT NOT NULL,
  hardware_snapshot_id TEXT,
  model_id TEXT,
  model_revision TEXT,
  runtime_kind TEXT,
  source_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_benchmarks_workload ON benchmark_results(workload_hash);

	CREATE TABLE IF NOT EXISTS suite_results (
	  suite_result_id TEXT PRIMARY KEY,
	  service_instance_id TEXT,
	  profile_id TEXT NOT NULL,
	  profile_hash TEXT NOT NULL,
	  model_id TEXT,
	  model_revision TEXT,
	  runtime_kind TEXT,
	  hardware_snapshot_id TEXT,
	  source_run_id TEXT NOT NULL,
	  created_at TEXT NOT NULL,
	  payload_json TEXT NOT NULL,
	  content_hash TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_suite_service ON suite_results(service_instance_id, profile_id);

	CREATE TABLE IF NOT EXISTS correctness_results (
	  correctness_result_id TEXT PRIMARY KEY,
	  service_instance_id TEXT,
	  profile_id TEXT NOT NULL,
	  source_run_id TEXT NOT NULL,
	  created_at TEXT NOT NULL,
	  payload_json TEXT NOT NULL,
	  content_hash TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_correctness_service ON correctness_results(service_instance_id, profile_id);

	CREATE TABLE IF NOT EXISTS cache_pair_results (
	  cache_pair_result_id TEXT PRIMARY KEY,
	  service_instance_id TEXT,
	  profile_id TEXT NOT NULL,
	  source_run_id TEXT NOT NULL,
	  created_at TEXT NOT NULL,
	  payload_json TEXT NOT NULL,
	  content_hash TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_cache_pair_service ON cache_pair_results(service_instance_id, profile_id);

	CREATE TABLE IF NOT EXISTS pd_estimates (
	  pd_estimate_id TEXT PRIMARY KEY,
	  service_instance_id TEXT,
	  profile_id TEXT NOT NULL,
	  source_run_id TEXT NOT NULL,
	  created_at TEXT NOT NULL,
	  payload_json TEXT NOT NULL,
	  content_hash TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_pd_service ON pd_estimates(service_instance_id, profile_id);

	CREATE TABLE IF NOT EXISTS experiments (
  experiment_id TEXT PRIMARY KEY,
  objective TEXT,
  source_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  report_id TEXT PRIMARY KEY,
  title TEXT,
  source_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL
);

"""

#: inspect_records kind -> table, primary id column and filterable columns.
_FACT_TABLES = {
    "hardware_snapshot": ("hardware_snapshots", "hardware_snapshot_id", ("created_at", "hardware_snapshot_id")),
    "deployment_plan": ("deployment_plans", "plan_id", ("created_at", "plan_id", "status", "hardware_snapshot_id", "model_id", "model_revision", "runtime_kind")),
    "service_instance": ("service_instances", "service_instance_id", ("created_at", "service_instance_id", "plan_id", "ownership", "runtime_kind", "model_id", "model_revision", "endpoint")),
    "benchmark_result": ("benchmark_results", "benchmark_result_id", ("created_at", "benchmark_result_id", "service_instance_id", "workload_hash", "hardware_snapshot_id", "model_id", "model_revision", "runtime_kind")),
    "suite_result": ("suite_results", "suite_result_id", ("created_at", "suite_result_id", "service_instance_id", "profile_id", "profile_hash", "model_id", "model_revision", "runtime_kind", "hardware_snapshot_id")),
    "correctness_result": ("correctness_results", "correctness_result_id", ("created_at", "correctness_result_id", "service_instance_id", "profile_id")),
    "cache_pair_result": ("cache_pair_results", "cache_pair_result_id", ("created_at", "cache_pair_result_id", "service_instance_id", "profile_id")),
    "pd_estimate": ("pd_estimates", "pd_estimate_id", ("created_at", "pd_estimate_id", "service_instance_id", "profile_id")),
    "experiment": ("experiments", "experiment_id", ("created_at", "experiment_id")),
    "report": ("reports", "report_id", ("created_at", "report_id")),
}

_MAX_LIST_LIMIT = 100
_MAX_EXCERPT_BYTES = 65_536
_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def core_home() -> Path:
    override = os.environ.get("BITTUNE_CORE_HOME", "").strip()
    return Path(override) if override else Path.home() / ".bittune" / "core"


def _path_inside(root: Path, relative: str) -> Path:
    result = (root / relative).resolve()
    if not result.is_relative_to(root.resolve()):
        raise ContractError("invalid_input", "Artifact 引用越过了受管存储边界。", {"relative_path": relative})
    return result


class CoreStore:
    """Owns the database connection, artifact files and staging directory."""

    def __init__(self, home: str | os.PathLike[str] | None = None):
        self.home = Path(home) if home else core_home()
        self.artifact_root = self.home / "artifacts"
        self.staging_root = self.home / "staging"
        self.home.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.artifact_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.staging_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Access is serial: one handler thread at a time, joined before the
        # next request starts (the protocol enforces a single in-flight
        # request). check_same_thread=False because each request runs on its
        # own thread while the connection is opened on the session thread.
        self.db = sqlite3.connect(self.home / "bittune.db", timeout=5.0, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;")
        self.db.executescript(_SCHEMA)
        self._relax_result_service_ids()
        self.db.commit()


    def _relax_result_service_ids(self) -> None:
        """CREATE TABLE IF NOT EXISTS does not drop NOT NULL on an existing file.

        Declared measurements store SQL NULL in service_instance_id. Rebuild
        only the five result tables that still declare that column NOT NULL.
        """
        indexes = {
            "benchmark_results": ("CREATE INDEX IF NOT EXISTS idx_benchmarks_workload ON benchmark_results(workload_hash)",),
            "suite_results": ("CREATE INDEX IF NOT EXISTS idx_suite_service ON suite_results(service_instance_id, profile_id)",),
            "correctness_results": ("CREATE INDEX IF NOT EXISTS idx_correctness_service ON correctness_results(service_instance_id, profile_id)",),
            "cache_pair_results": ("CREATE INDEX IF NOT EXISTS idx_cache_pair_service ON cache_pair_results(service_instance_id, profile_id)",),
            "pd_estimates": ("CREATE INDEX IF NOT EXISTS idx_pd_service ON pd_estimates(service_instance_id, profile_id)",),
        }
        for table, statements in indexes.items():
            info = self.db.execute(f"PRAGMA table_info({table})").fetchall()
            service = next((row for row in info if row["name"] == "service_instance_id"), None)
            if service is None or not service["notnull"]:
                continue
            columns = []
            for row in info:
                decl = f"{row['name']} {row['type'] or 'TEXT'}"
                if row["pk"]:
                    decl += " PRIMARY KEY"
                elif row["notnull"] and row["name"] != "service_instance_id":
                    decl += " NOT NULL"
                columns.append(decl)
            names = ", ".join(row["name"] for row in info)
            old = f"_{table}_notnull"
            self.db.execute(f"ALTER TABLE {table} RENAME TO {old}")
            self.db.execute(f"CREATE TABLE {table} ({', '.join(columns)})")
            self.db.execute(f"INSERT INTO {table}({names}) SELECT {names} FROM {old}")
            self.db.execute(f"DROP TABLE {old}")
            for statement in statements:
                self.db.execute(statement)

    def close(self) -> None:
        self.db.close()

    # -- lifecycle -------------------------------------------------------

    def mark_interrupted_runs(self) -> int:
        """Any Run left `running` by a dead Core becomes `interrupted` on the
        next open. This is the Run status for an unclean Runtime/Core exit,
        not a Plan or Service state machine."""
        cursor = self.db.execute("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'", (utc_now(),))
        self.db.commit()
        return cursor.rowcount

    # -- runs ------------------------------------------------------------

    def start_run(self, tool_name: str, action_path: str, input_value: dict[str, Any], session_id: str) -> tuple[str, str]:
        if action_path not in ("generic", "managed"):
            raise ContractError("invalid_input", "action_path 必须是 generic 或 managed。", {"action_path": action_path})
        run_id = f"run-{uuid.uuid4()}"
        started_at = utc_now()
        sanitized = redact(input_value)
        input_json = canonical_json(sanitized)
        self.db.execute(
            "INSERT INTO runs(run_id, session_id, tool_name, action_path, started_at, status, input_json, input_hash, created_at)"
            " VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)",
            (run_id, session_id, tool_name, action_path, started_at, input_json, sha256_canonical(sanitized), utc_now()),
        )
        self.db.commit()
        return run_id, started_at

    def experiment_budget_usage(self, scope_hash: str) -> dict[str, int]:
        """Count trusted reservations, including failed/interrupted Runs."""
        usage = dict(suite_calls=0, points=0, requests=0)
        rows = self.db.execute("SELECT * FROM runs WHERE tool_name = 'benchmark_suite' AND action_path = 'managed'")
        for row in rows:
            self._verify_run_hashes(row)
            value = json.loads(row['input_json'])
            reservation = value.get('_experiment_reservation')
            if value.get('_task_scope_hash') == scope_hash and reservation:
                usage['suite_calls'] += 1
                usage['points'] += reservation['points']
                usage['requests'] += reservation['requests']
        return usage

    def finish_run(self, run_id: str, status: str, observation: dict[str, Any]) -> None:
        if status not in RUN_STATUSES or status == "running":
            raise ContractError("invalid_input", "Run 终态必须是 completed、failed、cancelled 或 interrupted。", {"status": status})
        sanitized = redact(observation)
        row = self.db.execute("SELECT status FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if row is None:
            raise ContractError("not_found", f"Run {run_id} 不存在。", {"run_id": run_id})
        if row["status"] != "running":
            raise ContractError("state_conflict", f"Run {run_id} 已提交过，不能重复写入。", {"run_id": run_id})
        self.db.execute(
            "UPDATE runs SET status = ?, finished_at = ?, observation_json = ?, observation_hash = ? WHERE run_id = ?",
            (status, utc_now(), canonical_json(sanitized), sha256_canonical(sanitized), run_id),
        )
        self.db.commit()

    def cancel_run(self, run_id: str, message: str = "Operation cancelled.") -> None:
        try:
            self.finish_run(
                run_id,
                "cancelled",
                {
                    "run_id": run_id,
                    "measured_at": utc_now(),
                    "ok": False,
                    "summary": message,
                    "error": {"code": "cancelled", "message": message},
                    "warnings": [],
                    "artifact_refs": [],
                },
            )
        except ContractError:
            # A Run that already reached a terminal status needs no rewrite.
            return

    def get_run(self, run_id: str) -> dict[str, Any]:
        if not RUN_ID.match(run_id):
            raise ContractError("invalid_input", "run_id 格式不合法。", {"run_id": run_id})
        row = self.db.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if row is None:
            raise ContractError("not_found", f"Run {run_id} 不存在。", {"run_id": run_id}, remediation="用 inspect_records.list(kind=run) 查找既有 Run ID。")
        self._verify_run_hashes(row)
        observation = json.loads(row["observation_json"]) if row["observation_json"] else None
        return {
            "run_id": row["run_id"],
            "session_id": row["session_id"],
            "tool_name": row["tool_name"],
            "action_path": row["action_path"],
            "started_at": row["started_at"],
            "finished_at": row["finished_at"],
            "status": row["status"],
            "input": redact(json.loads(row["input_json"])),
            "observation": observation,
            "artifacts": self._artifact_refs(row["run_id"]),
        }

    def list_runs(self, limit: int = 20, tool_name: str | None = None, status: str | None = None, session_id: str | None = None) -> list[dict[str, Any]]:
        limit = max(1, min(limit, _MAX_LIST_LIMIT))
        clauses = ["status != 'running'"]
        params: list[Any] = []
        if tool_name:
            clauses.append("tool_name = ?")
            params.append(tool_name)
        if status:
            if status not in RUN_STATUSES:
                raise ContractError("invalid_input", "status filter is invalid.", {"status": status})
            clauses.append("status = ?")
            params.append(status)
        if session_id:
            clauses.append("session_id = ?")
            params.append(session_id)
        rows = self.db.execute(
            f"SELECT run_id FROM runs WHERE {' AND '.join(clauses)} ORDER BY finished_at DESC LIMIT ?", (*params, limit)
        ).fetchall()
        return [self.get_run(row["run_id"]) for row in rows]


    @staticmethod
    def _verify_run_hashes(row: sqlite3.Row) -> None:
        if sha256_canonical(json.loads(row["input_json"])) != row["input_hash"]:
            raise ContractError("state_conflict", f"Run {row['run_id']} input hash mismatch.", {"run_id": row["run_id"]})
        if row["observation_json"] and sha256_canonical(json.loads(row["observation_json"])) != row["observation_hash"]:
            raise ContractError("state_conflict", f"Run {row['run_id']} observation hash mismatch.", {"run_id": row["run_id"]})

    # -- artifacts -------------------------------------------------------

    def write_artifact(self, run_id: str, label: str, content: str | bytes, media_type: str = "text/plain") -> dict[str, Any]:
        if not RUN_ID.match(run_id):
            raise ContractError("invalid_input", "run_id 格式不合法。", {"run_id": run_id})
        if label:
            label = redact_text(label)[:160]
        if isinstance(content, str):
            sanitized = redact_text(content).encode("utf-8")
        elif isinstance(content, bytes):
            # Text evidence supplied as bytes still passes through the same
            # redaction boundary; opaque binary artifacts remain byte-exact.
            try:
                decoded = content.decode("utf-8")
            except UnicodeDecodeError:
                sanitized = content
            else:
                sanitized = redact_text(decoded).encode("utf-8")
        else:
            raise ContractError("invalid_input", "Artifact content must be text or bytes.", {"type": type(content).__name__})
        if len(sanitized) > _MAX_ARTIFACT_BYTES:
            raise ContractError(
                "payload_too_large",
                f"Artifact cannot exceed {_MAX_ARTIFACT_BYTES} bytes.",
                {"size_bytes": len(sanitized), "max_bytes": _MAX_ARTIFACT_BYTES},
            )
        digest = sha256_bytes(sanitized)
        extension = "json" if (media_type == "application/json" or media_type.endswith("+json")) else "log"
        relative_path = f"artifacts/{digest[len('sha256:'):]}.{extension}"
        target = self.home / relative_path
        if not target.exists():
            temporary = target.with_name(f"{target.name}.{uuid.uuid4().hex}.tmp")
            temporary.write_bytes(sanitized)
            temporary.rename(target)
        artifact_id = f"artifact-{uuid.uuid4()}"
        self.db.execute(
            "INSERT INTO artifacts(artifact_id, run_id, label, media_type, size_bytes, sha256, relative_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (artifact_id, run_id, label, media_type, len(sanitized), digest, relative_path, utc_now()),
        )
        self.db.commit()
        return {"artifact_id": artifact_id, "label": label, "media_type": media_type, "size_bytes": len(sanitized), "sha256": digest}

    def artifact_row(self, artifact_id: str) -> dict[str, Any] | None:
        if not ARTIFACT_ID.match(artifact_id):
            return None
        row = self.db.execute("SELECT artifact_id, label, media_type, size_bytes, sha256 FROM artifacts WHERE artifact_id = ?", (artifact_id,)).fetchone()
        return dict(row) if row is not None else None

    def read_artifact_excerpt(self, artifact_id: str, offset_bytes: int = 0, max_bytes: int = 4096) -> dict[str, Any]:
        if not ARTIFACT_ID.match(artifact_id):
            raise ContractError("invalid_input", "artifact_id 格式不合法。", {"artifact_id": artifact_id})
        if not isinstance(offset_bytes, int) or offset_bytes < 0 or not isinstance(max_bytes, int) or max_bytes < 1 or max_bytes > _MAX_EXCERPT_BYTES:
            raise ContractError("invalid_input", "Artifact 读取范围不合法。", {"offset_bytes": offset_bytes, "max_bytes": max_bytes})
        row = self.db.execute("SELECT sha256, relative_path, size_bytes, media_type, label FROM artifacts WHERE artifact_id = ?", (artifact_id,)).fetchone()
        if row is None:
            raise ContractError("not_found", f"Artifact {artifact_id} 不存在。", {"artifact_id": artifact_id})
        path = _path_inside(self.home, row["relative_path"])
        raw = path.read_bytes()
        if len(raw) != row["size_bytes"] or sha256_bytes(raw) != row["sha256"]:
            raise ContractError("state_conflict", f"Artifact {artifact_id} hash mismatch.", {"artifact_id": artifact_id})
        return {
            "artifact_id": artifact_id,
            "label": row["label"],
            "media_type": row["media_type"],
            "size_bytes": row["size_bytes"],
            "sha256": row["sha256"],
            "offset_bytes": offset_bytes,
            "text": raw[offset_bytes : offset_bytes + max_bytes].decode("utf-8", errors="replace"),
            "truncated": offset_bytes + max_bytes < len(raw),
        }

    def read_artifact_bytes(self, artifact_id: str) -> bytes:
        """Hash-verified bytes for local exports; never round-trip a binary via UTF-8."""
        if not ARTIFACT_ID.match(artifact_id):
            raise ContractError("invalid_input", "Artifact ID 不合法。")
        row = self.db.execute("SELECT relative_path,size_bytes,sha256 FROM artifacts WHERE artifact_id=?", (artifact_id,)).fetchone()
        if row is None:
            raise ContractError("not_found", "Artifact 不存在。")
        data = _path_inside(self.home, row["relative_path"]).read_bytes()
        if len(data) != row["size_bytes"] or sha256_bytes(data) != row["sha256"]:
            raise ContractError("state_conflict", "Artifact hash mismatch.")
        return data

    def read_artifact_text(self, artifact_id: str) -> dict[str, Any]:
        """Full UTF-8 body for Core consumers that must parse JSON.

        Excerpt is capped at 64 KiB. Structured JSON readers
        must not raise that cap; they call this when the excerpt is truncated.
        The 8 MiB write cap is the bound.
        """
        if not ARTIFACT_ID.match(artifact_id):
            raise ContractError("invalid_input", "artifact_id 格式不合法。", {"artifact_id": artifact_id})
        row = self.db.execute(
            "SELECT sha256, relative_path, size_bytes, media_type, label FROM artifacts WHERE artifact_id = ?",
            (artifact_id,),
        ).fetchone()
        if row is None:
            raise ContractError("not_found", f"Artifact {artifact_id} 不存在。", {"artifact_id": artifact_id})
        path = _path_inside(self.home, row["relative_path"])
        raw = path.read_bytes()
        if len(raw) != row["size_bytes"] or sha256_bytes(raw) != row["sha256"]:
            raise ContractError("state_conflict", f"Artifact {artifact_id} hash mismatch.", {"artifact_id": artifact_id})
        return {
            "artifact_id": artifact_id,
            "label": row["label"],
            "media_type": row["media_type"],
            "size_bytes": row["size_bytes"],
            "sha256": row["sha256"],
            "text": raw.decode("utf-8", errors="replace"),
        }

    def list_run_artifacts(self, run_id: str) -> list[dict[str, Any]]:
        rows = self.db.execute(
            "SELECT artifact_id, label, sha256, relative_path FROM artifacts WHERE run_id = ? ORDER BY created_at",
            (run_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def _artifact_refs(self, run_id: str) -> list[dict[str, Any]]:
        rows = self.db.execute(
            "SELECT artifact_id, label, media_type, size_bytes, sha256 FROM artifacts WHERE run_id = ? ORDER BY created_at", (run_id,)
        ).fetchall()
        return [dict(row) for row in rows]

    # -- staging ---------------------------------------------------------

    def staging_path(self, session_id: str, filename: str) -> Path:
        if Path(filename).name != filename or not filename:
            raise ContractError("invalid_input", "staging 文件名必须是纯文件名。", {"filename": filename})
        session_dir = self.staging_root / session_id
        session_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        return session_dir / filename

    # -- facts -----------------------------------------------------------

    def put_fact(self, kind: str, fact_id: str, payload: dict[str, Any], source_run_id: str, created_at: str) -> None:
        """Insert an immutable fact; re-inserting the same id is a conflict."""
        provenance = payload.get("provenance")
        if provenance not in PROVENANCE_VALUES:
            raise ContractError(
                "invalid_provenance",
                f"Fact provenance must be one of {', '.join(PROVENANCE_VALUES)}; got {provenance!r}.",
                {"provenance": provenance},
            )
        table, id_column, _ = self._fact_table(kind)
        self.db.execute(
            f"INSERT INTO {table} ({id_column}, source_run_id, created_at, payload_json, content_hash) VALUES (?, ?, ?, ?, ?)",
            (fact_id, source_run_id, created_at, canonical_json(payload), sha256_canonical(payload)),
        )
        self.db.commit()

    def put_hardware_snapshot(self, snapshot: dict[str, Any], source_run_id: str) -> None:
        self.put_fact("hardware_snapshot", snapshot["hardware_snapshot_id"], snapshot, source_run_id, snapshot.get("observed_at") or utc_now())

    def put_deployment_plan(self, plan: dict[str, Any], source_run_id: str, expected_content_hash: str | None = None) -> None:
        """Plans are the single mutable fact: draft rows update in place,
        frozen rows are immutable. Query columns stay consistent with the
        payload through every write."""
        row = self.db.execute("SELECT status, content_hash FROM deployment_plans WHERE plan_id = ?", (plan["plan_id"],)).fetchone()
        if expected_content_hash is not None and (row is None or row["content_hash"] != expected_content_hash):
            raise ContractError(
                "state_conflict",
                f"Plan {plan['plan_id']} changed while it was being evaluated.",
                {"plan_id": plan["plan_id"], "expected_content_hash": expected_content_hash},
                remediation="重新读取 draft 后 validate；冻结态变更请新建 plan。",
            )
        if row is not None and row["status"] == "frozen":
            if plan["status"] != "frozen" or sha256_canonical(plan) != row["content_hash"]:
                raise ContractError(
                    "state_conflict",
                    f"Plan {plan['plan_id']} is already frozen and cannot be modified.",
                    {"plan_id": plan["plan_id"]},
                    remediation="Create a new draft plan when the intent changes.",
                )
            return
        payload_json = canonical_json(plan)
        content_hash = sha256_canonical(plan)
        model_ref = plan.get("model_ref") if isinstance(plan.get("model_ref"), dict) else {}
        runtime_spec = plan.get("runtime_spec") if isinstance(plan.get("runtime_spec"), dict) else {}
        if expected_content_hash is None:
            self.db.execute(
            "INSERT INTO deployment_plans(plan_id, status, hardware_snapshot_id, model_id, model_revision, runtime_kind, source_run_id, created_at, payload_json, content_hash)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(plan_id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json, content_hash = excluded.content_hash,"
            " hardware_snapshot_id = excluded.hardware_snapshot_id, model_id = excluded.model_id, model_revision = excluded.model_revision,"
            " runtime_kind = excluded.runtime_kind",
            (
                plan["plan_id"],
                plan["status"],
                plan.get("hardware_snapshot_id"),
                model_ref.get("model_id"),
                model_ref.get("revision"),
                runtime_spec.get("runtime_kind"),
                source_run_id,
                plan.get("created_at") or utc_now(),
                payload_json,
                content_hash,
                ),
            )
        else:
            cursor = self.db.execute(
                "UPDATE deployment_plans SET status = ?, payload_json = ?, content_hash = ?, hardware_snapshot_id = ?, model_id = ?, model_revision = ?, runtime_kind = ?, source_run_id = ? WHERE plan_id = ? AND content_hash = ?",
                (plan["status"], payload_json, content_hash, plan.get("hardware_snapshot_id"), model_ref.get("model_id"), model_ref.get("revision"), runtime_spec.get("runtime_kind"), source_run_id, plan["plan_id"], expected_content_hash),
            )
            if cursor.rowcount != 1:
                raise ContractError("state_conflict", f"Plan {plan['plan_id']} changed before it could be saved.", {"plan_id": plan["plan_id"]})
        self.db.commit()

    def put_service_instance(self, service: dict[str, Any], source_run_id: str) -> None:
        payload_json = canonical_json(service)
        model_ref = service.get("model_ref") or {}
        self.db.execute(
            "INSERT INTO service_instances(service_instance_id, plan_id, ownership, runtime_kind, model_id, model_revision, endpoint, last_observed_at, source_run_id, created_at, payload_json, content_hash)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(service_instance_id) DO UPDATE SET"
            " ownership = excluded.ownership, endpoint = excluded.endpoint, last_observed_at = excluded.last_observed_at,"
            " payload_json = excluded.payload_json, content_hash = excluded.content_hash",
            (
                service["service_instance_id"],
                service.get("plan_id"),
                service["ownership"],
                service.get("runtime_spec", {}).get("runtime_kind") if isinstance(service.get("runtime_spec"), dict) else None,
                model_ref.get("model_id") if isinstance(model_ref, dict) else None,
                model_ref.get("revision") if isinstance(model_ref, dict) else None,
                service.get("endpoint"),
                service.get("last_observed_at") or utc_now(),
                source_run_id,
                service.get("created_at") or utc_now(),
                payload_json,
                sha256_canonical(service),
            ),
        )
        self.db.commit()

    def put_benchmark_result(self, result: dict[str, Any], source_run_id: str) -> None:
        self._check_provenance(result)
        model_ref = result.get("model_ref") or {}
        runtime_spec = result.get("runtime_spec") or {}
        self.db.execute(
            "INSERT INTO benchmark_results(benchmark_result_id, service_instance_id, workload_hash, hardware_snapshot_id, model_id, model_revision, runtime_kind, source_run_id, created_at, payload_json, content_hash)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                result["benchmark_result_id"],
                result.get("service_instance_id"),
                result.get("workload_hash"),
                result.get("hardware_snapshot_id"),
                model_ref.get("model_id"),
                model_ref.get("revision"),
                runtime_spec.get("runtime_kind"),
                source_run_id,
                result.get("measured_at") or utc_now(),
                canonical_json(result),
                sha256_canonical(result),
            ),
        )
        self.db.commit()

    def put_suite_result(self, result: dict[str, Any], source_run_id: str) -> None:
        self._put_indexed_fact(
            "suite_results",
            "suite_result_id",
            result,
            source_run_id,
            (
                "service_instance_id",
                "profile_id",
                "profile_hash",
                "model_id",
                "model_revision",
                "runtime_kind",
                "hardware_snapshot_id",
            ),
        )

    def put_correctness_result(self, result: dict[str, Any], source_run_id: str) -> None:
        self._put_indexed_fact(
            "correctness_results",
            "correctness_result_id",
            result,
            source_run_id,
            ("service_instance_id", "profile_id"),
        )

    def put_cache_pair_result(self, result: dict[str, Any], source_run_id: str) -> None:
        self._put_indexed_fact(
            "cache_pair_results",
            "cache_pair_result_id",
            result,
            source_run_id,
            ("service_instance_id", "profile_id"),
        )

    def put_pd_estimate(self, result: dict[str, Any], source_run_id: str) -> None:
        self._put_indexed_fact(
            "pd_estimates",
            "pd_estimate_id",
            result,
            source_run_id,
            ("service_instance_id", "profile_id"),
        )

    def _put_indexed_fact(
        self,
        table: str,
        id_column: str,
        payload: dict[str, Any],
        source_run_id: str,
        columns: tuple[str, ...],
    ) -> None:
        if payload.get("provenance") not in ("derived", "estimated", "measured"):
            payload = {**payload, "provenance": payload.get("provenance") or "derived"}
        self._check_provenance(payload)
        model_ref = payload.get("model_ref") if isinstance(payload.get("model_ref"), dict) else {}
        runtime_spec = payload.get("runtime_spec") if isinstance(payload.get("runtime_spec"), dict) else {}
        indexed = {
            "service_instance_id": payload.get("service_instance_id"),
            "profile_id": payload.get("profile_id"),
            "profile_hash": payload.get("profile_hash"),
            "model_id": model_ref.get("model_id"),
            "model_revision": model_ref.get("revision"),
            "runtime_kind": runtime_spec.get("runtime_kind"),
            "hardware_snapshot_id": payload.get("hardware_snapshot_id"),
        }
        names = (id_column, *columns, "source_run_id", "created_at", "payload_json", "content_hash")
        values = [payload[id_column], *[indexed.get(column) for column in columns], source_run_id, payload.get("created_at") or utc_now(), canonical_json(payload), sha256_canonical(payload)]
        placeholders = ", ".join("?" for _ in names)
        self.db.execute(f"INSERT INTO {table}({', '.join(names)}) VALUES ({placeholders})", values)
        self.db.commit()

    def put_experiment(self, experiment: dict[str, Any], source_run_id: str) -> None:
        self._check_provenance(experiment)
        self.db.execute(
            "INSERT INTO experiments(experiment_id, objective, source_run_id, created_at, payload_json, content_hash) VALUES (?, ?, ?, ?, ?, ?)",
            (
                experiment["experiment_id"],
                experiment.get("objective"),
                source_run_id,
                experiment.get("created_at") or utc_now(),
                canonical_json(experiment),
                sha256_canonical(experiment),
            ),
        )
        self.db.commit()

    def put_report(self, report: dict[str, Any], source_run_id: str) -> None:
        self._check_provenance(report)
        self.db.execute(
            "INSERT INTO reports(report_id, title, source_run_id, created_at, payload_json, content_hash) VALUES (?, ?, ?, ?, ?, ?)",
            (
                report["report_id"],
                report.get("title"),
                source_run_id,
                report.get("created_at") or utc_now(),
                canonical_json(report),
                sha256_canonical(report),
            ),
        )
        self.db.commit()

    @staticmethod
    def _check_provenance(payload: dict[str, Any]) -> None:
        provenance = payload.get("provenance")
        if provenance not in PROVENANCE_VALUES:
            raise ContractError(
                "invalid_provenance",
                f"Fact provenance must be one of {', '.join(PROVENANCE_VALUES)}; got {provenance!r}.",
                {"provenance": provenance},
            )

    def get_fact(self, kind: str, fact_id: str) -> dict[str, Any]:
        table, id_column, _ = self._fact_table(kind)
        row = self.db.execute(f"SELECT * FROM {table} WHERE {id_column} = ?", (fact_id,)).fetchone()
        if row is None:
            raise ContractError("not_found", f"{kind} {fact_id} 不存在。", {"kind": kind, "id": fact_id}, remediation=f"用 inspect_records.list(kind={kind}) 查找既有记录。")
        self._verify_fact_row(kind, row)
        return self._render_fact(kind, row)

    def list_facts(self, kind: str, limit: int = 20, *, allowed_ids: set[str] | None = None, **filters: Any) -> list[dict[str, Any]]:
        table, id_column, filterable = self._fact_table(kind)
        limit = max(1, min(limit, _MAX_LIST_LIMIT))
        clauses: list[str] = []
        params: list[Any] = []
        for column, value in filters.items():
            if value is None:
                continue
            if column not in filterable:
                raise ContractError("invalid_input", f"记录类型 {kind} 不支持过滤条件 {column}。", {"kind": kind, "filter": column})
            clauses.append(f"{column} = ?")
            params.append(value)
        if allowed_ids is not None:
            if not allowed_ids:
                return []
            ids = sorted(allowed_ids)
            clauses.append(f"{id_column} IN ({','.join('?' for _ in ids)})")
            params.extend(ids)
        rows = self.db.execute(
            f"SELECT * FROM {table} WHERE {' AND '.join(clauses) if clauses else '1=1'} ORDER BY created_at DESC LIMIT ?",
            (*params, limit),
        ).fetchall()
        return [self._render_fact(kind, self._verify_fact_row(kind, row)) for row in rows]

    def _fact_table(self, kind: str) -> tuple[str, str, tuple[str, ...]]:
        entry = _FACT_TABLES.get(kind)
        if entry is None:
            raise ContractError("invalid_input", f"未知记录类型 {kind}。", {"kind": kind})
        return entry

    @staticmethod
    def _verify_fact_row(kind: str, row: sqlite3.Row) -> sqlite3.Row:
        if sha256_canonical(json.loads(row["payload_json"])) != row["content_hash"]:
            raise ContractError("state_conflict", f"{kind} {row[0]} content hash mismatch.", {"kind": kind, "id": row[0]})
        return row

    @staticmethod
    def _render_fact(kind: str, row: sqlite3.Row) -> dict[str, Any]:
        _, id_column, _ = _FACT_TABLES[kind]
        return {
            "kind": kind,
            "id": row[id_column],
            "payload": redact(json.loads(row["payload_json"])),
            "content_hash": row["content_hash"],
            "source_run_id": row["source_run_id"],
            "created_at": row["created_at"],
        }
