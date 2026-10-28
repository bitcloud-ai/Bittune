from pathlib import Path
from unittest import TestCase


class AisimNotShippedTests(TestCase):
    def test_installer_requirements_omit_aisimulate(self) -> None:
        root = Path(__file__).resolve().parents[3]
        text = (root / "install" / "requirements.txt").read_text(encoding="utf-8")
        lowered = text.lower()
        self.assertNotIn("aisimulate", lowered)
        self.assertNotIn("aisim-service", lowered)
