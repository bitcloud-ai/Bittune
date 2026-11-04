#!/usr/bin/env python3
"""Install reviewed local V3 resources and invoke their offline utilities."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tempfile
import zipfile

VERSION = "3.0.1"
BUNDLE_SHA256 = "2beca42137c2bfd0fb7b814c7d0137b4a5f761ab5f691f700bba37adf53c93c3"
DOCUMENTS_SHA256 = "8fdfc9cf28400e700d97fb0fb62821ad6f5b8237ff985433c2fd3598fb8d4700"
FAMILIES = {"single-node": "llm-inference-benchmark", "pd-cluster": "pd-cluster-inference-benchmark"}


def assets_root() -> Path:
    configured = os.environ.get("BITTUNE_BENCHMARK_ASSETS")
    return Path(configured).expanduser() if configured else Path(os.environ.get("BITTUNE_HOME", str(Path.home() / ".bittune"))) / "benchmark-assets" / VERSION


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def checked_zip(path: str, expected: str) -> zipfile.ZipFile:
    data = Path(path).read_bytes()
    if digest(data) != expected:
        raise ValueError("Resource archive differs from the reviewed V3.0.1 package; installation stopped.")
    archive = zipfile.ZipFile(io.BytesIO(data))
    if archive.testzip() is not None:
        raise ValueError("Corrupt archive")
    return archive


def relative_name(info: zipfile.ZipInfo) -> PurePosixPath:
    name = info.filename
    if not info.flag_bits & 0x800:
        try:
            name = name.encode("cp437").decode("utf-8")
        except UnicodeError:
            pass
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or (info.external_attr >> 16) & 0o170000 == 0o120000:
        raise ValueError("Archive contains an unsafe path")
    return path


def install(archive_path: str, documents_path: str | None, target: Path) -> dict:
    bundle = checked_zip(archive_path, BUNDLE_SHA256)
    manifest_path = next(n for n in bundle.namelist() if n.endswith("/MANIFEST.json"))
    prefix = manifest_path.removesuffix("MANIFEST.json")
    manifest = json.loads(bundle.read(manifest_path))
    for item in manifest["files"]:
        if digest(bundle.read(prefix + item["path"])) != item["sha256"]:
            raise ValueError("Bundle manifest mismatch: " + item["path"])
    documents = checked_zip(documents_path, DOCUMENTS_SHA256) if documents_path else None
    if target.exists():
        marker = target / "installed.json"
        if not marker.is_file():
            raise ValueError("Refusing to replace a directory without a Bittune resource receipt")
        previous = json.loads(marker.read_text(encoding="utf-8"))
        if previous.get("version") != VERSION:
            raise ValueError("Existing directory belongs to a different resource version")
        if previous.get("documents_sha256") == (DOCUMENTS_SHA256 if documents else None) and all((target / f["path"]).is_file() and digest((target / f["path"]).read_bytes()) == f["sha256"] for f in previous["files"]):
            return {"installed": str(target), "version": VERSION, "files": len(previous["files"]), "unchanged": True, "multi_node_execution_integrated": False}
    receipt = {"version": VERSION, "bundle_sha256": BUNDLE_SHA256, "documents_sha256": DOCUMENTS_SHA256 if documents else None, "files": [], "multi_node_execution_integrated": False}
    target.parent.mkdir(parents=True, exist_ok=True)
    # Validate and stage before changing an existing installation.
    with tempfile.TemporaryDirectory(prefix="bittune-benchmark-", dir=target.parent) as tmp:
        staged = Path(tmp) / VERSION
        staged.mkdir()

        def save(relative: Path, data: bytes) -> None:
            destination = staged / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            receipt["files"].append({"path": str(relative), "sha256": digest(data)})

        for family, skill_name in FAMILIES.items():
            package = prefix + f"packages/{family}/{skill_name}-{VERSION}.skill"
            skill = zipfile.ZipFile(io.BytesIO(bundle.read(package)))
            for info in skill.infolist():
                rel = relative_name(info)
                if info.is_dir() or rel.parts[0] != skill_name:
                    continue
                rel = PurePosixPath(*rel.parts[1:])
                if rel.parts[0] not in {"scripts", "references", "assets", "data", "SKILL.md"} or "__pycache__" in rel.parts:
                    continue
                destination = Path(family) / ("UPSTREAM_SKILL.md" if str(rel) == "SKILL.md" else str(rel))
                save(destination, skill.read(info))
        for info in bundle.infolist():
            rel = relative_name(info)
            if not info.is_dir() and "/docs/test-plans/" in str(rel):
                save(Path("documents/bundled") / Path(*rel.parts).name, bundle.read(info))
        if documents:
            for info in documents.infolist():
                rel = relative_name(info)
                if not info.is_dir() and rel.suffix in {".docx", ".xlsx"}:
                    save(Path("documents/supplemental") / str(rel), documents.read(info))
        (staged / "installed.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if target.exists():
            old = target.with_name(target.name + ".previous")
            if old.exists():
                raise ValueError("Previous installation backup exists; choose a fresh asset directory.")
            target.rename(old)
        shutil.move(str(staged), target)
    return {"installed": str(target), "version": VERSION, "files": len(receipt["files"]), "multi_node_execution_integrated": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    installer = sub.add_parser("install", help="Import the reviewed local archives; no network or GPU work")
    installer.add_argument("--archive", required=True)
    installer.add_argument("--documents")
    sub.add_parser("status")
    reference = sub.add_parser("reference")
    reference.add_argument("family", choices=FAMILIES)
    reference.add_argument("path", help="Relative references/*.md or *.json file")
    catalog = sub.add_parser("catalog")
    catalog.add_argument("family", choices=FAMILIES)
    catalog.add_argument("args", nargs=argparse.REMAINDER)
    for command in ["cache-plan", "pd-plan", "workbook"]:
        sub.add_parser(command).add_argument("args", nargs=argparse.REMAINDER)
    # Pass vendor options unchanged; `--` keeps them out of this parser.
    args = parser.parse_args()
    root = assets_root()
    if args.command == "install":
        print(json.dumps(install(args.archive, args.documents, root), ensure_ascii=False))
        return 0
    if not (root / "installed.json").is_file():
        raise ValueError("V3 resources are not installed. Use install --archive <local.zip> [--documents <local.zip>].")
    if args.command == "status":
        receipt = json.loads((root / "installed.json").read_text(encoding="utf-8"))
        print(json.dumps({"root": str(root), "version": receipt["version"], "files": len(receipt["files"]), "multi_node_execution_integrated": False}))
        return 0
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
    except (ValueError, OSError, zipfile.BadZipFile) as exc:
        print(f"Bittune benchmark resources: {exc}", file=sys.stderr)
        raise SystemExit(2)
