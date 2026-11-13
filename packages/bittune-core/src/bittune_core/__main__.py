"""Entry point for the BitTune local Core.

The Runtime launches `python -m bittune_core` and speaks a UTF-8 JSONL
request/progress/result/cancel protocol over stdin/stdout. The process opens
the local Store (~/.bittune/core or $BITTUNE_CORE_HOME), marks Runs left
`running` by a previous dead session as `interrupted`, and exits when the
Runtime closes stdin. It never listens on a port and never outlives its
session.
"""

import sys
import json
import base64
import atexit

from bittune_core import __version__
from bittune_core.lifecycle import CoreLease
from bittune_core.contracts import ContractError
from bittune_core.suite_profiles import load_profile
from bittune_core.benchmark import benchmark_service
from bittune_core.compare import compare_results
from bittune_core.deliverable import export_deliverable
from bittune_core.evidence import ingest_evidence, inspect_records
from bittune_core.inspect import inspect_environment, inspect_service, gpu_activity
from bittune_core.plans import plan_deployment
from bittune_core.protocol import Channel, Server
from bittune_core.correctness import correctness_pack_info
from bittune_core.reports import write_report
from bittune_core.services import deploy_service
from bittune_core.store import CoreStore
from bittune_core.suite import benchmark_suite
from bittune_core.task_scope import TaskScope


def _print_version() -> None:
    print(f"bittune-core {__version__}")


def _configure_utf8_stdio() -> None:
    """Keep the JSONL protocol UTF-8 even when Windows uses a legacy locale."""
    for stream in (sys.stdin, sys.stdout):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")


def build_server(*, read_only: bool = False) -> Server:
    if not read_only:
        lease = CoreLease()
        atexit.register(lease.close)
    task_scope = TaskScope.from_env()
    store = CoreStore(read_only=read_only)
    if not read_only:
        store.mark_interrupted_runs()
    channel = Channel(sys.stdin, sys.stdout)
    channel.start_reader()

    def wrap(handler):
        if task_scope is not None:
            return task_scope.bind(handler, store)
        def bound(params, context):
            context["store"] = store
            return handler(params, context)

        return bound

    def scope_status(params, context):
        if task_scope:
            task_scope.restore_history(store, context["session_id"])
        return {"scope": task_scope.summary() if task_scope else None}

    def check_scope(params, context):
        context['store']=store
        if task_scope:
            context['task_scope']=task_scope
            task_scope.enforce(params['tool'], params['params'], context)
        return {"allowed": True}

    def artifact_content(params, context):
        artifact_id = params.get("artifact_id")
        if task_scope and not task_scope.record_allowed("artifact", artifact_id):
            task_scope.denied("制品不在当前任务范围。")
        meta = store.artifact_row(artifact_id)
        if not meta:
            raise ContractError("not_found", "制品不存在。")
        if meta["size_bytes"] > 16 * 1024 * 1024:
            raise ContractError("payload_too_large", "单次读取上限16MiB；请使用本机原始制品。")
        return {**meta, "data_base64": base64.b64encode(store.read_artifact_bytes(artifact_id)).decode("ascii")}

    def scope_file_info(params, context):
        from pathlib import Path
        scope = TaskScope(json.loads(Path(params["path"]).read_text()))
        return {"scope_hash": scope.scope_hash, "usage": scope.budget_usage(store), "previous_scope_hashes": scope.document.get("experiment_budget", {}).get("previous_scope_hashes", [])}

    def profile_info(params, context):
        return load_profile(params.get("path"))

    handlers = {
            "task_scope_status": scope_status,
            "artifact_content": artifact_content,
            "profile_info": profile_info,
            "scope_file_info": scope_file_info,
            "gpu_activity": wrap(gpu_activity),
            "correctness_pack_info": wrap(correctness_pack_info),
            "check_task_scope": check_scope,
            "inspect_records": wrap(inspect_records),
            "ingest_evidence": wrap(ingest_evidence),
            "inspect_environment": wrap(inspect_environment),
            "inspect_service": wrap(inspect_service),
            "plan_deployment": wrap(plan_deployment),
            "deploy_service": wrap(deploy_service),
            "benchmark_service": wrap(benchmark_service),
            "benchmark_suite": wrap(benchmark_suite),
            "export_deliverable": wrap(export_deliverable),
            "compare_results": wrap(compare_results),
            "write_report": wrap(write_report),
        }
    if read_only:
        handlers = {name: handler for name, handler in handlers.items() if name in ("inspect_records", "artifact_content", "correctness_pack_info")}
    return Server(channel, handlers)


def _main(argv: list[str]) -> int:
    _configure_utf8_stdio()
    if argv == ["--version"]:
        _print_version()
        return 0
    if argv and argv != ["--read-only"]:
        print(f"bittune-core {__version__}\nusage: python -m bittune_core [--version|--read-only]", file=sys.stderr)
        return 2
    try:
        server = build_server(read_only=argv == ["--read-only"])
    except ContractError as error:
        print(f"{error.code}: {error.message}", file=sys.stderr)
        return 2
    server.run_forever()
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
