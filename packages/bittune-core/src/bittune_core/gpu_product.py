"""Map nvidia-smi GPU names onto the frozen product table.

The table is a versioned local GPU product catalog. Lookup is
exact then first contains hit. Unmapped names return None so the export can
still upload without entering compare or ranking.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_TABLE_PATH = Path(__file__).resolve().parent / "data" / "gpu_products.json"


@lru_cache(maxsize=1)
def _table() -> dict:
    return json.loads(_TABLE_PATH.read_text(encoding="utf-8"))


def gpu_product_exact_keys() -> frozenset[str]:
    """nvidia-smi names that are simulation lookup keys, not family names."""
    exact = _table().get("exact") or {}
    return frozenset(exact)


def gpu_product(name: str | None) -> str | None:
    trimmed = (name or "").strip()
    if not trimmed:
        return None
    table = _table()
    exact = table.get("exact") or {}
    if trimmed in exact:
        return exact[trimmed]
    for rule in table.get("contains") or []:
        needle = rule.get("needle") or ""
        product = rule.get("product") or ""
        if needle and product and needle in trimmed:
            return product
    return None
