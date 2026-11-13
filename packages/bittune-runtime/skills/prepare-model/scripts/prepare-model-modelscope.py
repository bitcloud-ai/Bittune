"""ModelScope's SDK owns download, resume and file verification."""
from pathlib import Path
import sys

try:
    from modelscope.hub.snapshot_download import snapshot_download
except ImportError:
    raise SystemExit("prepare-model: ModelScope SDK is not installed in the preparation Python environment")

model_id, revision, cache_dir = sys.argv[1:]
path = snapshot_download(model_id, revision=revision or None, cache_dir=cache_dir)
print(str(Path(path).resolve()))
