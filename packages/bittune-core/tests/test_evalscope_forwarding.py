"""Opt-in Core -> installed EvalScope -> loopback HTTP request regression.

No model or GPU: a generated tokenizer and HTTP stub exercise the real CLI.
Run with BITTUNE_EVALSCOPE_INTEROP=1 in an EvalScope 1.10.0 perf environment.
"""

import importlib.metadata
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bittune_core.benchmark import execute_workload, materialize_workload  # noqa: E402
from bittune_core.contracts import ContractError  # noqa: E402
from bittune_core.runs import ManagedRun  # noqa: E402
from bittune_core.store import CoreStore  # noqa: E402


class SamplingInputTest(unittest.TestCase):
    def test_invalid_sampling_fails_before_provider_execution(self) -> None:
        base = {"schema_version": 2, "mode": "closed_loop", "concurrency": 1, "request_count": 2, "input_tokens": 16, "output_tokens": 4}
        for field, values in {
            "seed": (-1, 2**32, True),
            "temperature": (-0.1, float("nan"), float("inf"), True),
            "top_p": (0, 1.1, float("nan"), True),
        }.items():
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises(ContractError):
                    materialize_workload({**base, field: value}, "fixture", "1.10.0")

    def test_prefix_is_included_in_total_input_budget(self) -> None:
        base = {"schema_version": 2, "mode": "closed_loop", "concurrency": 1, "request_count": 2, "input_tokens": 16, "output_tokens": 4}
        for prefix in (-1, 17, True):
            with self.subTest(prefix=prefix), self.assertRaises(ContractError):
                materialize_workload(base, "fixture", "1.10.0", prefix_length=prefix)
        self.assertEqual(materialize_workload(base, "fixture", "1.10.0", prefix_length=4)["input_tokens"], 16)


@unittest.skipUnless(os.environ.get("BITTUNE_EVALSCOPE_INTEROP") == "1", "opt-in installed EvalScope HTTP interop")
class EvalScopeForwardingTest(unittest.TestCase):
    def test_core_parameters_arrive_in_real_provider_requests(self) -> None:
        self.assertEqual(importlib.metadata.version("evalscope"), "1.10.0")
        from tokenizers import Tokenizer, models, pre_tokenizers
        from transformers import PreTrainedTokenizerFast

        received = []
        paths = []
        measurements = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received.append(body)
                paths.append(self.path)
                prompt_tokens = len(body["prompt"]) if isinstance(body.get("prompt"), list) else 16
                usage = {"prompt_tokens": prompt_tokens, "completion_tokens": 4, "total_tokens": prompt_tokens + 4}
                if body.get("stream"):
                    chunks = [
                        {"id": "stub", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": "hello "}, "finish_reason": None}]},
                        {"id": "stub", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": "world"}, "finish_reason": "length"}], "usage": usage},
                    ]
                    if self.path == "/v1/completions":
                        for chunk in chunks:
                            choice = chunk["choices"][0]
                            choice["text"] = choice.pop("delta")["content"]
                    data = ("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
                    content_type = "text/event-stream"
                else:
                    data = json.dumps({"id": "stub", "object": "chat.completion", "choices": [{"index": 0, "message": {"role": "assistant", "content": "hello world"}, "finish_reason": "length"}], "usage": usage}).encode()
                    content_type = "application/json"
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory(prefix="bittune-evalscope-interop-") as directory:
            root = Path(directory)
            tokenizer = Tokenizer(models.WordLevel({"[UNK]": 0, **{f"word{i}": i + 1 for i in range(512)}}, unk_token="[UNK]"))
            tokenizer.pre_tokenizer = pre_tokenizers.Whitespace()
            PreTrainedTokenizerFast(
                tokenizer_object=tokenizer, unk_token="[UNK]",
                chat_template="{% for message in messages %}{{ message['content'] }}{% endfor %}",
            ).save_pretrained(root / "tokenizer")
            store = CoreStore(str(root / "core"))
            try:
                for seed, temperature, top_p, stream, prefix in ((0, 0, 1, True, 0), (17, 0.7, 0.8, False, 0), (17, 0.7, 0.8, True, 4)):
                    with self.subTest(seed=seed, stream=stream), mock.patch("bittune_core.benchmark._GpuSampler") as sampler:
                        sampler.return_value.stop.return_value = None
                        start = len(received)
                        workload = {"schema_version": 2, "mode": "closed_loop", "concurrency": 1, "request_count": 2, "input_tokens": 16, "output_tokens": 4, "request_timeout_seconds": 60, "seed": seed, "temperature": temperature, "top_p": top_p, "stream": stream}
                        with ManagedRun(store, "provider-interop-test", workload, "interop", {}) as run:
                            acceptance = {"schema_version":2,"success_rate_min":1,"latency_comparison":"raw_ms","request_limits_ms":{"e2e":5000},"p99_limits_ms":{"e2e":5000},"stop_policy":{"throughput_drop_ratio":.2}}
                            outcome = execute_workload(workload, service={"endpoint": f"http://127.0.0.1:{server.server_port}"}, model_ref={"model_id": "synthetic-http-stub"}, provider_version="1.10.0", tokenizer_path=str(root / "tokenizer"), store=store, run=run, cancellation=None, prefix_length=prefix, acceptance=acceptance)
                            if not outcome["ok"]:
                                for ref in run.artifact_refs:
                                    if ref["label"] == "evalscope-cli":
                                        print(store.read_artifact_excerpt(ref["artifact_id"], max_bytes=20000)["text"])
                            self.assertTrue(outcome["ok"], outcome)
                            self.assertEqual(outcome["measurement"]["status"], "complete")
                            self.assertGreater(outcome["measurement"]["metrics"]["goodput_req_per_s"], 0)
                            self.assertIsNotNone(outcome["measurement"]["dataset_input_sha256"])
                            measurements.append(outcome["measurement"])
                            self.assertTrue(outcome["request_samples_available"])
                            self.assertEqual(outcome["request_evidence"]["status"], "complete")
                            self.assertEqual(outcome["request_evidence"]["row_count"], 2)
                            self.assertEqual(outcome["distributions"]["e2e_latency_ms"]["sample_count"], 2)
                            self.assertEqual("ttft_ms" in outcome["distributions"], stream)
                            run.success("HTTP stub interop complete; no inference model")
                        requests = received[start:]
                        self.assertGreaterEqual(len(requests), 2)
                        self.assertEqual(set(paths[start:]), {"/v1/completions"})
                        # EvalScope sends a separate synthetic "hello" connectivity
                        # probe; it is not inserted into the measurement database.
                        measured = [request for request in requests if len(request.get("prompt", [])) == 16]
                        self.assertEqual(len(measured), 2)
                        self.assertEqual(len(requests) - len(measured), 1)
                        if prefix:
                            self.assertEqual(len({tuple(request["prompt"][:prefix]) for request in measured}), 1)
                        for request in requests:
                            self.assertIsInstance(request.get("prompt"), list)
                            self.assertTrue(all(isinstance(token, int) for token in request["prompt"]))
                            for field, value in {"seed": seed, "temperature": temperature, "top_p": top_p, "stream": stream, "ignore_eos": True}.items():
                                self.assertEqual(request[field], value, (field, request))
                evidence = os.environ.get("BITTUNE_INTEROP_EVIDENCE")
                if evidence:
                    Path(evidence).write_text(json.dumps({"provider_version": "1.10.0", "target": "synthetic loopback HTTP stub; no GPU", "requests": received, "measurements": measurements}, indent=2))
            finally:
                store.close()
