"""Content identity for an existing flat Transformers checkpoint. Never writes."""
import hashlib
import os
from pathlib import Path
from typing import Any

from bittune_core.contracts import ContractError, sha256_canonical


def local_model_identity(value: Any, cancellation: Any = None) -> tuple[str, str]:
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise ContractError("invalid_input", "model_ref.local_path 必须是已有模型目录的绝对路径。")
    root = Path(value).resolve()
    protected = [Path(os.environ.get("BITTUNE_HOME", str(Path.home() / ".bittune"))).resolve()]
    if os.environ.get("BITTUNE_CORE_HOME"):
        protected.append(Path(os.environ["BITTUNE_CORE_HOME"]).resolve())
    if any(root.is_relative_to(path) for path in protected):
        raise ContractError("invalid_input", "不能将 Bittune 自有目录作为模型目录。")
    if not root.is_dir() or not (root / "config.json").is_file():
        raise ContractError("model_snapshot_missing", "本地模型目录不存在或缺少 config.json。")
    files = sorted(path for path in root.iterdir() if not path.name.startswith(".") and path.is_file())
    if not any(path.suffix.lower() in (".safetensors", ".bin", ".pt", ".pth") for path in files):
        raise ContractError("model_snapshot_missing", "本地 Transformers 模型目录缺少权重文件。")
    manifest = []
    for path in files:
        if not path.resolve().is_relative_to(root):
            raise ContractError("invalid_input", "本地模型文件链接越出了模型目录。", {"file": path.name})
        before = path.stat()
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            while chunk := stream.read(4 * 1024 * 1024):
                if cancellation is not None:
                    cancellation.raise_if_requested()
                digest.update(chunk)
        after = path.stat()
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ContractError("model_content_changed", "生成本地模型身份时文件发生变化，请重试。", {"file": path.name})
        manifest.append({"name": path.name, "sha256": digest.hexdigest()})
    return str(root), "local-" + sha256_canonical(manifest).removeprefix("sha256:")
