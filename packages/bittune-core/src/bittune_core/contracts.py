"""Stable data contracts for the Core: statuses, identifiers and hashing.

Everything the Core persists is verifiable independently of how it was
created: evidence and fact payloads are redacted, serialized deterministically
(`canonical_json`) and content-hashed; every read re-verifies the hash.
"""

import hashlib
import json
import re
from typing import Any

RUN_STATUSES = ("running", "completed", "failed", "cancelled", "interrupted")

GENERIC_TOOL_NAMES = ("bash", "read", "edit", "write")

#: Provenance labels allowed in `provenance-v1`. New labels (e.g. `modeled`)
#: require an explicit published bump of the fact schema version.
PROVENANCE_VALUES = ("declared", "detected", "measured", "derived", "estimated")

#: Who named the object. Missing on an old row means `bound`. This is not a
#: sixth provenance word: a declared endpoint can still be `measured`.
BINDING_VALUES = ("bound", "declared")

RUN_ID = re.compile(r"^run-[a-f0-9-]{36}$")
ARTIFACT_ID = re.compile(r"^artifact-[a-f0-9-]{36}$")

# ---------------------------------------------------------------------------
# Suite contract freeze (phase 7). Row states, claim metrics and workbook
# columns live here once. Reports, XLSX and scripts/check-suite-contract.mjs
# read this tuple set; they do not keep a second copy.
# ---------------------------------------------------------------------------

SUITE_SCHEMA_VERSION = 1
SUITE_PROFILE_ID = "bittune-default-v1"
EARLY_STOP_FORMULA_VERSION = "early-stop-v1"
SUITE_COMPARISON_METHOD = "suite-points-v1"
SLO_JUDGEMENT_VERSION = "slo-judgement-v1"

SUITE_INTENTS = ("performance_sweep", "correctness", "cache_pair", "pd_planning")
DELIVERABLE_INTENTS = ("result_workbook", "evidence_pack")
SUITE_PACKAGES = ("short", "full")

SUITE_ROW_STATES = (
    "healthy",
    "measured",
    "not_run_budget",
    "invalid_measurement",
    "unsupported_context_length",
    "not_run_early_stop",
    "not_run_context_limit",
    "not_run_safety_stop",
    "not_applicable",
    "not_selected",
    "evidence_insufficient",
    "skipped_prior_failure",
    "environment_blocked",
)

#: Metrics a suite_claim may name. Values are read from the row, never typed.
SUITE_CLAIM_METRICS = (
    "requests_per_second",
    "output_tokens_per_second",
    "p50_ttft_ms",
    "p99_ttft_ms",
    "p99_e2e_latency_ms",
    "success_rate",
    "goodput_req_per_s",
)

from bittune_core.measurement import METRIC_NAMES as MEASUREMENT_METRICS, CONTRACT as MEASUREMENT_CONTRACT
WORKBOOK_DETAIL_COLUMNS_V2 = tuple(MEASUREMENT_CONTRACT["row_columns"])
SUITE_CLAIM_METRICS = tuple(dict.fromkeys((*SUITE_CLAIM_METRICS, *MEASUREMENT_METRICS)))

PD_CLAIM_METRICS = (
    "p_cap_req_per_s",
    "d_cap_tok_per_s",
    "ratio_p_to_d",
)

SUITE_ROW_REQUIRED_FIELDS = (
    "scenario_id",
    "projection",
    "concurrency",
    "state",
    "reason_code",
    "reason_detail",
)

WORKBOOK_DETAIL_COLUMNS = (
    "scenario_id",
    "projection",
    "concurrency",
    "state",
    "reason_code",
    "requests_per_second",
    "output_tokens_per_second",
    "p50_ttft_ms",
    "p99_ttft_ms",
    "p99_e2e_latency_ms",
    "success_rate",
    "goodput_req_per_s",
)

WORKBOOK_BEST_COLUMNS = (
    "scenario_id",
    "concurrency",
    "goodput_req_per_s",
    "output_tokens_per_second",
    "state",
)

WORKBOOK_PD_COLUMNS = (
    "p_cap_req_per_s",
    "d_cap_tok_per_s",
    "ratio_p_to_d",
    "provenance",
    "evidence_boundary",
    "formula",
)

#: Frozen GPU architecture names by CUDA compute capability major.minor.
GPU_ARCH_BY_CAPABILITY = {
    "7.5": "Turing",
    "8.0": "Ampere",
    "8.6": "Ampere",
    "8.9": "Ada",
    "9.0": "Hopper",
    "10.0": "Blackwell",
    "12.0": "Blackwell",
}


def sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def sha256_canonical(value: Any) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def canonical_json(value: Any) -> str:
    """Deterministic JSON: object keys sorted recursively, compact separators."""

    def normalize(item: Any) -> Any:
        if isinstance(item, dict):
            return {key: normalize(item[key]) for key in sorted(item)}
        if isinstance(item, list):
            return [normalize(child) for child in item]
        return item

    return json.dumps(normalize(value), separators=(",", ":"), ensure_ascii=False)




def _is_measure_fact(payload: dict[str, Any]) -> bool:
    """A benchmark result, or one suite row. Not the suite fact that wraps rows.

    A row's ``projection`` is a bucket object, so the check is key presence,
    not scalar types. The suite fact itself has ``suite_result_id`` and ``rows``
    and does not carry the row keys.
    """
    if isinstance(payload.get("benchmark_result_id"), str):
        return True
    return all(key in payload for key in SUITE_ROW_REQUIRED_FIELDS)


def claimable(payload: Any) -> bool:
    """Whether this fact may be called a BitTune measurement.

    True only when binding is missing or ``bound``, provenance is ``measured``,
    and the payload is a benchmark result or a suite row. ``binding`` does not change provenance.
    """
    if not isinstance(payload, dict):
        return False
    binding = payload.get("binding", "bound")
    if binding != "bound":
        return False
    if payload.get("provenance") != "measured":
        return False
    return _is_measure_fact(payload)


class ContractError(Exception):
    """A stable, machine-readable validation failure.

    `code` and `message` cross the protocol boundary verbatim; the Core never
    sends a bare exception text back to the Runtime.
    """

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None, remediation: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.remediation = remediation
        self.details = details or {}

    def to_result(self) -> dict[str, Any]:
        error: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.remediation:
            error["remediation"] = self.remediation
        if self.details:
            error["details"] = self.details
        return error