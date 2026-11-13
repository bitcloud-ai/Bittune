"""Export a pinned official Linux/amd64 image with the existing crane CLI."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time


def checked_blob(root, descriptor):
    algorithm, digest = descriptor['digest'].split(':', 1)
    if algorithm != 'sha256' or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise ValueError('Unsupported OCI blob digest')
    path = root / 'blobs' / algorithm / digest
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(block)
    if hasher.hexdigest() != digest or path.stat().st_size != descriptor['size']:
        raise ValueError('OCI blob integrity validation failed: ' + digest)
    return path


def verify_oci(root, expected):
    index = json.loads((root / 'index.json').read_text())
    if len(index['manifests']) != 1 or index['manifests'][0]['digest'] != expected:
        raise ValueError('Exported OCI image does not match the approved manifest')
    manifest = json.loads(checked_blob(root, index['manifests'][0]).read_text())
    config = json.loads(checked_blob(root, manifest['config']).read_text())
    if (config['os'], config['architecture']) != ('linux', 'amd64'):
        raise ValueError('Exported image is not Linux/amd64')
    for layer in manifest['layers']:
        checked_blob(root, layer)
    return manifest


def main():
    image, destination = sys.argv[1:]
    expected = image.split('@', 1)[1]
    root = Path(destination).expanduser()
    if not root.is_absolute():
        raise ValueError('OCI output directory must be absolute')
    root = root.resolve()
    if root.exists() and any(root.iterdir()) and not (root / 'oci-layout').is_file():
        raise ValueError('Refusing to overwrite a non-OCI directory')
    crane = os.environ.get('BITTUNE_CRANE') or shutil.which('crane')
    if not crane:
        raise RuntimeError('Image export requires the configured crane v0.20.6 executable')
    version = subprocess.check_output([crane, 'version'], text=True).strip()
    if version != 'v0.20.6':
        raise RuntimeError('Image export requires crane v0.20.6')
    root.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='bittune-image-auth-') as auth:
        config = Path(auth) / 'config.json'
        config.write_text('{"auths":{}}\n')
        env = {**os.environ, 'DOCKER_CONFIG': auth, 'REGISTRY_AUTH_FILE': str(config)}
        command = [crane, 'pull', '--platform=linux/amd64', '--format=oci', image, str(root)]
        print('准备官方镜像OCI制品：' + image, flush=True)
        with subprocess.Popen(command, env=env) as process:
            while process.poll() is None:
                size = 0
                for path in root.rglob('*') if root.exists() else []:
                    try:
                        if path.is_file():
                            size += path.stat().st_size
                    except FileNotFoundError:
                        pass  # crane atomically renames completed blobs.
                print('OCI目录当前数据量：' + str(size // (1024 * 1024)) + ' MiB', flush=True)
                time.sleep(10)
            if process.returncode:
                raise RuntimeError('crane export failed; completed OCI blobs remain for retry')
    manifest = verify_oci(root, expected)
    print(json.dumps({'image': image, 'platform': 'linux/amd64', 'manifest_digest': expected,
                      'layer_count': len(manifest['layers']), 'verified': True,
                      'output_path': str(root), 'node_import_completed': False}), flush=True)


if __name__ == '__main__':
    main()
