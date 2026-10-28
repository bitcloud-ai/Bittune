"""Phase 7 stage 0: profile schema rejects bad documents; the default projects."""

import json
import unittest
from pathlib import Path

from bittune_core.contracts import ContractError
from bittune_core.suite_profiles import load_builtin, load_document, load_profile, project_scenario

FIXTURES = Path(__file__).parent / "fixtures" / "suite"


class SuiteProfileTests(unittest.TestCase):
    def test_builtin_projects_rag_and_batch_buckets(self) -> None:
        profile = load_builtin()
        self.assertEqual(profile["profile_id"], "bittune-default-v1")
        by_id = {item["scenario_id"]: item for item in profile["registry"]["scenarios"]}
        rag = project_scenario("short-rag", by_id["short-rag"]["input_tokens"], by_id["short-rag"]["output_tokens"], 1)
        batch = project_scenario("short-batch", by_id["short-batch"]["input_tokens"], by_id["short-batch"]["output_tokens"], 1)
        self.assertEqual(rag["input_bucket"], "8193-32768")
        self.assertEqual(rag["scenario"], "rag")
        self.assertEqual(batch["output_bucket"], "2049-8192")
        self.assertEqual(batch["scenario"], "batch")
        self.assertNotIn("8193-32768", json.dumps(profile["registry"]))

    def test_missing_version_is_invalid_profile(self) -> None:
        document = json.loads((FIXTURES / "registry-missing-version.json").read_text(encoding="utf-8"))
        with self.assertRaises(ContractError) as raised:
            load_document(document, source="file")
        self.assertEqual(raised.exception.code, "invalid_profile")
        self.assertNotIn("jsonschema", raised.exception.message)

    def test_extra_field_is_invalid_profile(self) -> None:
        document = json.loads((FIXTURES / "registry-extra-field.json").read_text(encoding="utf-8"))
        with self.assertRaises(ContractError) as raised:
            load_document(document, source="file")
        self.assertEqual(raised.exception.code, "invalid_profile")

    def test_non_positive_concurrency_is_invalid_profile(self) -> None:
        document = json.loads((FIXTURES / "registry-bad-concurrency.json").read_text(encoding="utf-8"))
        with self.assertRaises(ContractError) as raised:
            load_document(document, source="file")
        self.assertEqual(raised.exception.code, "invalid_profile")

    def test_missing_file_is_invalid_profile(self) -> None:
        with self.assertRaises(ContractError) as raised:
            load_profile(str(FIXTURES / "no-such-profile.json"))
        self.assertEqual(raised.exception.code, "invalid_profile")


if __name__ == "__main__":
    unittest.main()
