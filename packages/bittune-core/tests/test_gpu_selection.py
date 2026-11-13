import csv
import unittest

from bittune_core.adapters import sglang, vllm


class GPUSelectionTests(unittest.TestCase):
    def test_device_list_is_one_docker_csv_field(self):
        # Docker CLI v24.0.9 parses --gpus with encoding/csv before splitting device IDs.
        for adapter in (vllm, sglang):
            for devices in ([0], [0, 1], list(range(8))):
                with self.subTest(adapter=adapter.__name__, devices=devices):
                    args = adapter.compile_docker_gpu_args({"gpu_device_ids": devices})
                    fields = next(csv.reader([args[1]]))
                    self.assertEqual(len(fields), 1)
                    self.assertEqual(fields[0].split("=", 1)[1].split(","), list(map(str, devices)))


if __name__ == "__main__":
    unittest.main()
