#!/usr/bin/env python3
"""Resolve Bittune benchmark resources and call their offline utilities."""
from __future__ import annotations

import argparse
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    reference = sub.add_parser("reference")
    reference.add_argument("family", choices=("single-node", "pd-cluster"))
    reference.add_argument("path")
    catalog = sub.add_parser("catalog")
    catalog.add_argument("family", choices=("single-node", "pd-cluster"))
    catalog.add_argument("args", nargs=argparse.REMAINDER)
    for command in ("cache-plan", "pd-plan", "workbook"):
        sub.add_parser(command).add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    configured = os.environ.get("BITTUNE_BENCHMARK_ASSETS")
    root = Path(configured).expanduser() if configured else Path(os.environ.get("BITTUNE_HOME", str(Path.home() / ".bittune"))) / "benchmark-assets" / "3.0.1"
    if not root.is_dir():
        raise ValueError("Bittune benchmark resources are unavailable in the configured workspace")
    if args.command == "reference":
        relative = PurePosixPath(args.path)
        if not relative.parts or relative.parts[0] != "references" or ".." in relative.parts or relative.suffix not in {".md", ".json"}:
            raise ValueError("Select a references/*.md or references/*.json file")
        print((root / args.family / args.path).read_text(encoding="utf-8"))
        return 0
    family = args.family if args.command == "catalog" else "single-node"
    script = {"catalog": "test_catalog.py", "cache-plan": "cache_lengths.py", "pd-plan": "pd_capacity.py", "workbook": "build_result_workbook.py"}[args.command]
    extra = args.args[1:] if args.args[:1] == ["--"] else args.args
    if args.command == "pd-plan" and "--capacity-basis" not in extra:
        extra = [*extra, "--capacity-basis", "deployment-instance"]
    if args.command == "workbook" and "--pd-result" not in extra:
        extra = [*extra, "--pd-result", ""]  # V3 requires the option even when no P/D analysis exists.
    return subprocess.call([os.environ.get("BITTUNE_CORE_PYTHON") or sys.executable, str(root / family / "scripts" / script), *extra])


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError) as exc:
        print(f"Bittune benchmark resources: {exc}", file=sys.stderr)
        raise SystemExit(2)
