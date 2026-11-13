"""An accelerator wheel's CLI help can select its documented CPU platform."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from bittune_core.adapters import inspect_image_cli

class EngineCliHelpTests(unittest.TestCase):
    def test_device_independent_help_and_fallback_do_not_start_a_model(self):
        calls = []
        def image(args, **kwargs):
            calls.append(args)
            cpu = '--env' in args and args[args.index('--env') + 1] == 'VLLM_TARGET_DEVICE=cpu'
            # Older engine CLIs can lack --help=all; the fallback needs CPU too.
            success = cpu and args[-1] == '--help'
            return {'exit_code': 0 if success else 1,
                    'stdout': '--model --served-model-name --host --port' if success else '',
                    'stderr': '' if success else 'Failed to infer device type'}
        result = inspect_image_cli('vllm', image, 'selected-image@sha256:test')
        self.assertIn('--model', result['flags'])
        self.assertEqual(len(calls), 2)
        for args in calls:
            self.assertNotIn('--gpus', args)
            self.assertNotIn('-d', args)
            self.assertNotIn('-v', args)
            self.assertIn('--network=none', args)
