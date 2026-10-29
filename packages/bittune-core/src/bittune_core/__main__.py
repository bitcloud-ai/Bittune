"""Entry point for the BitTune local Core.

The Runtime launches `python -m bittune_core` and speaks a UTF-8 JSONL
request/progress/result/cancel protocol over stdin/stdout. The process opens
the local Store (~/.bittune/core or $BITTUNE_CORE_HOME), marks Runs left
`running` by a previous dead session as `interrupted`, and exits when the
Runtime closes stdin. It never listens on a port and never outlives its
session.
"""

import sys

from bittune_core import __version__
from bittune_core.benchmark import benchmark_service
from bittune_core.compare import compare_results
from bittune_core.deliverable import export_deliverable
from bittune_core.evidence import ingest_evidence, inspect_records
from bittune_core.inspect import inspect_environment, inspect_service
from bittune_core.plans import plan_deployment
from bittune_core.protocol import Channel, Server
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


def build_server() -> Server:
    task_scope = TaskScope.from_env()
    store = CoreStore()
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
        return {"scope": task_scope.summary() if task_scope else None}

    def check_scope(params, context):
        context['store']=store
        if task_scope:
            context['task_scope']=task_scope
            task_scope.enforce(params['tool'], params['params'], context)
        return {"allowed": True}

    return Server(
        channel,
        {
            "task_scope_status": scope_status,
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
        },
    )


def _main(argv: list[str]) -> int:
    _configure_utf8_stdio()
    if argv == ["--version"]:
        _print_version()
        return 0
    if argv:
        print(f"bittune-core {__version__}\nusage: python -m bittune_core [--version]", file=sys.stderr)
        return 2
    server = build_server()
    server.run_forever()
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
