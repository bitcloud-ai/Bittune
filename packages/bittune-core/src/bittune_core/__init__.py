"""BitTune local Core.

The Core is the deterministic authority for BitTune managed work on one host:
it validates plans, owns managed service lifecycles, runs normalized benchmarks,
and is the only logical writer of the local Store (Runs, Artifacts, facts, reports).

It uses only the Python standard library plus the pinned measurement tooling
(evalscope / huggingface-hub) already installed beside Bittune.
"""

__version__ = "0.1.0"