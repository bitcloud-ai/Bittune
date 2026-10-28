"""Smoke tests for the Core package entry point.

The Core is a src-layout package that is installed into its own virtualenv on
the target host; these tests import the source tree directly so they run both
on the dev machine and before installation.
"""

import subprocess
import sys
import unittest
from pathlib import Path

SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_ROOT))

import bittune_core


class EntryPointTest(unittest.TestCase):
    def test_version_matches_package(self) -> None:
        self.assertRegex(bittune_core.__version__, r"^\d+\.\d+\.\d+$")
        result = subprocess.run(
            [sys.executable, "-m", "bittune_core", "--version"],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=SRC_ROOT,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), f"bittune-core {bittune_core.__version__}")

    def test_unknown_arguments_exit_nonzero(self) -> None:
        result = subprocess.run(
            [sys.executable, "-m", "bittune_core", "--not-an-option"],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=SRC_ROOT,
        )
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()