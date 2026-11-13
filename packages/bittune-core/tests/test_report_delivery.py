"""Report export regression: cross-service closure and actual PDF signatures."""
import io
import importlib.util
import json
import shutil
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bittune_core.deliverable import export_deliverable
from bittune_core.report_pdf import verify_signed_pdf
from bittune_core.reports import write_report
from bittune_core.contracts import sha256_bytes
import test_suite_compare_report as fixtures


@unittest.skipUnless(sys.version_info >= (3, 11) and importlib.util.find_spec("pyhanko") and importlib.util.find_spec("reportlab"), "requires optional Python 3.11+ reports runtime")
class ReportDeliveryTests(unittest.TestCase):
    def setUp(self):
        f = self.fixture = fixtures.CompareReportTests("runTest")
        f.setUp()
        self.addCleanup(shutil.rmtree, f.work)
        self.addCleanup(f.tearDown)
        run, _ = f.core.store.start_run("fixture", "managed", {}, "delivery-fixture")
        f.core.store.finish_run(run, "completed", {"summary": "CPU fixture, not a measurement"})
        f.core.store.db.execute("UPDATE runs SET run_id = ? WHERE run_id = ?",
            ("run-00000000-0000-4000-8000-000000000000", run))
        self.suites = ["suite-00000000-0000-4000-8000-000000000001", "suite-00000000-0000-4000-8000-000000000002"]
        f._suite(self.suites[0], 1, 10)
        old = f.core.store.get_fact("service_instance", f.service_id)["payload"]
        f.service_id = "service-22222222-2222-4222-8222-222222222211"
        f.core.store.put_service_instance({**old, "service_instance_id": f.service_id},
            "run-00000000-0000-4000-8000-000000000000")
        f._suite(self.suites[1], 1, 11)
        for sid in self.suites:
            suite = f.core.store.get_fact("suite_result", sid)["payload"]
            row = suite["rows"][0]
            f.core.store.put_benchmark_result({"schema_version": 1, "benchmark_result_id": row["benchmark_result_id"],
                "service_instance_id": suite["service_instance_id"], "model_ref": suite["model_ref"],
                "workload_hash": "sha256:" + "a" * 64, "metrics": row["metrics"],
                "artifact_ids": [], "provenance": "measured"}, "run-00000000-0000-4000-8000-000000000000")
        f._suite("suite-00000000-0000-4000-8000-000000000003", 1, 99)
        self.report = f.core.request(write_report, {"title": '=HYPERLINK("https://example.invalid")',
            "scope": "中文报告交付回归，不是GPU实测。", "narrative": "保留原始来源及全部工作点。", "conclusion": "仅测试导出。",
            "suite_selections": [{"suite_result_id": sid, "metrics": ["requests_per_second"]} for sid in self.suites]})["data"]["report"]

    def test_bundle_includes_both_services_exact_sources_and_verifiable_pdf(self):
        result = self.fixture.core.request(export_deliverable,
            {"intent": "report_bundle", "report_id": self.report["report_id"]})
        store = self.fixture.core.store
        with zipfile.ZipFile(io.BytesIO(store.read_artifact_bytes(result["data"]["artifact"]["artifact_id"]))) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            main = archive.read("report.md").decode("utf-8")
            self.assertIn("## 结论", main)
            self.assertIn(self.report["report_id"], main)
            self.assertEqual(main, store.read_artifact_bytes(self.report["artifact_ids"][0]).decode("utf-8"))
            self.assertIn("## 追溯", store.read_artifact_bytes(self.report["artifact_ids"][1]).decode("utf-8"))
            self.assertEqual(set(manifest["suite_ids"]), set(self.suites))
            self.assertEqual(sum(x["kind"] == "service_instance" for x in manifest["facts"]), 2)
            self.assertEqual(sum(x["kind"] == "benchmark_result" for x in manifest["facts"]), 2)
            self.assertFalse(any("key.pem" in n for n in archive.namelist()))
            for row in manifest["files"]:
                self.assertEqual(sha256_bytes(archive.read(row["path"])), row["sha256"])
            signature = verify_signed_pdf(archive.read("report/signed-report.pdf"), archive.read("report/signing-certificate.pem"))
            self.assertTrue(signature["document_intact"] and signature["cryptographically_valid"])
            from cryptography import x509
            from cryptography.hazmat.primitives import hashes
            from cryptography.hazmat.primitives.asymmetric import padding
            public = x509.load_pem_x509_certificate(archive.read("report/signing-certificate.pem")).public_key()
            public.verify(archive.read("manifest.sig"), archive.read("manifest.json"), padding.PKCS1v15(), hashes.SHA256())
            from openpyxl import load_workbook
            book = load_workbook(io.BytesIO(archive.read("all-workpoints.xlsx")))
            self.assertEqual(book["全部工作点"].max_row, 3)
            self.assertEqual(book["来源索引"]["B1"].data_type, "s")
            self.assertTrue(book["来源索引"]["B1"].value.startswith("'="))

    def test_pdf_tampering_invalidates_signature_and_identity_is_stable(self):
        store = self.fixture.core.store
        params = {"intent": "signed_pdf", "report_id": self.report["report_id"]}
        first = self.fixture.core.request(export_deliverable, params)
        second = self.fixture.core.request(export_deliverable, params)
        self.assertEqual(first["data"]["signature"]["certificate_fingerprint"], second["data"]["signature"]["certificate_fingerprint"])
        pdf = store.read_artifact_bytes(first["data"]["artifact"]["artifact_id"])
        certificate = next(a for a in first["artifact_refs"] if a["label"] == "report-signing-certificate")
        self.assertIn(b"ReportLab", pdf)
        status = verify_signed_pdf(pdf.replace(b"ReportLab", b"XeportLab", 1), store.read_artifact_bytes(certificate["artifact_id"]))
        self.assertFalse(status["document_intact"])


if __name__ == "__main__":
    unittest.main()
