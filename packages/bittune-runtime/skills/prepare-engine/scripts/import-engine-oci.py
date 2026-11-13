"""Import the verified official OCI image through a loopback registry mirror."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time


def main():
    image, directory = sys.argv[1:]
    root = Path(directory)
    if not root.is_absolute():
        raise ValueError('OCI input directory must be absolute')
    spec = importlib.util.spec_from_file_location('bittune_oci', Path(__file__).with_name('export-engine-oci.py'))
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    manifest = helper.verify_oci(root.resolve(), image.split('@', 1)[1])
    crane = os.environ.get('BITTUNE_CRANE') or shutil.which('crane')
    registry = os.environ.get('BITTUNE_OCI_REGISTRY') or shutil.which('registry')
    if not crane or not registry or subprocess.check_output([crane, 'version'], text=True).strip() != 'v0.20.6':
        raise RuntimeError('Offline import requires the configured crane/registry v0.20.6 tools')
    port = int(os.environ.get('BITTUNE_OCI_REGISTRY_PORT', '17500'))
    if not 1024 <= port <= 65535:
        raise ValueError('Invalid loopback registry port')
    mirror = f'http://localhost:{port}/'
    info = json.loads(subprocess.check_output(['docker', 'info', '--format', '{{json .}}'], text=True))
    if mirror not in info.get('RegistryConfig', {}).get('Mirrors', []):
        raise RuntimeError('The selected Docker daemon must already use the configured loopback registry mirror')
    with tempfile.TemporaryDirectory(prefix='bittune-image-import-') as private:
        config = Path(private) / 'config.json'
        config.write_text('{"auths":{}}\n')
        env = {**os.environ, 'DOCKER_CONFIG': private, 'REGISTRY_AUTH_FILE': str(config)}
        with (Path(private) / 'registry.log').open('wb') as log:
            process = subprocess.Popen([registry, '-port', str(port)], stdout=log, stderr=log)
            try:
                for _ in range(50):
                    if process.poll() is not None:
                        raise RuntimeError('The dedicated loopback registry did not start')
                    if f'serving on port {port}' in (Path(private) / 'registry.log').read_text():
                        break
                    time.sleep(.1)
                else:
                    raise RuntimeError('The dedicated loopback registry did not become ready')
                local = f'localhost:{port}/' + image.split('@', 1)[0] + ':prepared'
                subprocess.run([crane, 'push', '--insecure', str(root), local], env=env, check=True)
                subprocess.run(['docker', 'pull', '--platform=linux/amd64', image], env=env, check=True)
                installed = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image], env=env, text=True))[0]
                if installed['Id'] != manifest['config']['digest'] or image not in installed.get('RepoDigests', []):
                    raise RuntimeError('Imported Docker image identity does not match the approved OCI manifest')
                print(json.dumps({'image': image, 'image_id': installed['Id'], 'verified': True,
                                  'node_import_completed': True, 'model_started': False}), flush=True)
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


if __name__ == '__main__':
    main()
