"""GPU product table lookup."""

import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_ROOT))

from bittune_core.gpu_product import _TABLE_PATH, gpu_product  # noqa: E402


class GpuProductTests(unittest.TestCase):
    def test_exact_and_contains(self) -> None:
        self.assertEqual(gpu_product("NVIDIA GeForce RTX 4090"), "RTX 4090")
        self.assertEqual(gpu_product("NVIDIA L40S"), "L40S")
        self.assertEqual(gpu_product("Something H100 SXM"), "H100")
        self.assertIsNone(gpu_product("Unknown Accelerator"))
        self.assertIsNone(gpu_product(""))

    def test_table_ships_next_to_the_module(self) -> None:
        self.assertTrue(_TABLE_PATH.is_file(), _TABLE_PATH)

    def test_wheel_includes_gpu_products_json(self) -> None:
        import subprocess

        package = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                [sys.executable, "-m", "pip", "wheel", "--no-deps", "--wheel-dir", tmp, str(package)],
                check=False,
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                self.skipTest(result.stderr or result.stdout)
            wheels = list(Path(tmp).glob("bittune_core-*.whl"))
            self.assertEqual(len(wheels), 1, wheels)
            names = zipfile.ZipFile(wheels[0]).namelist()
            self.assertIn("bittune_core/data/gpu_products.json", names)
