"""Run scoping for managed Core tools.

Every managed tool call is one Run: started before work, committed with
completed/failed/cancelled after. Artifacts written during the call are
referenced from the observation. The Run status comes from what the Core
actually did - never from what the Agent asked for.
"""

from typing import Any

from bittune_core.contracts import ContractError
from bittune_core.store import CoreStore, utc_now


class ManagedRun:
    def __init__(self, store: CoreStore, tool_name: str, input_value: dict[str, Any], session_id: str, context: dict[str, Any]):
        self.store = store
        self.context = context
        self.artifact_refs: list[dict[str, Any]] = []
        input_value = {key: value for key, value in input_value.items() if key != '_experiment_reservation'}
        if context.get('task_scope') is not None:
            input_value = {**input_value, '_task_scope_hash': context['task_scope'].scope_hash}
        if tool_name == 'benchmark_suite' and context.get('experiment_reservation'):
            input_value['_experiment_reservation'] = context['experiment_reservation']
        self.run_id, _ = store.start_run(tool_name, "managed", input_value, session_id)
        if context.get('task_scope') is not None:
            context['task_scope'].records.add(self.run_id)

    def progress(self, message: str) -> None:
        emit = self.context.get("emit_progress")
        if emit:
            emit(message)

    def artifact(self, label: str, content: str, media_type: str = "text/plain") -> dict[str, Any]:
        ref = self.store.write_artifact(self.run_id, label, content, media_type)
        self.artifact_refs.append(ref)
        if self.context.get('task_scope') is not None:
            self.context['task_scope'].records.add(ref['artifact_id'])
        return ref

    def success(self, summary: str, data: dict[str, Any] | None = None, warnings: list[str] | None = None, stored: dict[str, Any] | None = None) -> dict[str, Any]:
        observation: dict[str, Any] = {"summary": summary, "warnings": warnings or [], "artifact_refs": self.artifact_refs}
        if stored:
            observation.update(stored)
        self.store.finish_run(self.run_id, "completed", observation)
        result: dict[str, Any] = {"summary": summary, "run_id": self.run_id, "artifact_refs": self.artifact_refs}
        if data is not None:
            result["data"] = data
        if warnings:
            result["warnings"] = warnings
        return result

    def failure(self, error: ContractError) -> None:
        if error.code == "cancelled":
            self.store.cancel_run(self.run_id, error.message)
        else:
            self.store.finish_run(
                self.run_id,
                "failed",
                {"summary": error.message, "warnings": [], "artifact_refs": self.artifact_refs, "error": error.to_result()},
            )

    def __enter__(self) -> "ManagedRun":
        return self

    def __exit__(self, exc_type, exc, traceback) -> bool:
        if isinstance(exc, ContractError):
            self.failure(exc)
        elif exc is not None:
            self.store.finish_run(
                self.run_id,
                "failed",
                {
                    "summary": getattr(exc, "message", None) or str(exc),
                    "warnings": [],
                    "artifact_refs": self.artifact_refs,
                    "error": {"code": "internal", "message": "Core handler failed."},
                },
            )
        return False
