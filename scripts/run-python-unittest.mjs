/**
 * Cross-platform Python unittest entry: Ubuntu 24.04 only ships `python3`,
 * while Windows/macOS often only have `python`. Resolves python3 → python and
 * runs the Core unittest suite from the repo root.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const candidates = process.env.BITTUNE_TEST_PYTHON?.trim() ? [process.env.BITTUNE_TEST_PYTHON.trim()] : process.platform === "win32" ? ["python", "py"] : ["python3", "python"];

let python = "";
for (const candidate of candidates) {
	try {
		const probe = execFileSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
		if (/\d/.test(probe)) {
			python = candidate;
			break;
		}
	} catch {
		// keep probing
	}
}
if (!python) {
	throw new Error("未找到可用的 Python 解释器（python3/python）；设置 BITTUNE_TEST_PYTHON 覆盖。");
}
execFileSync(python, ["-m", "unittest", "discover", "-s", "packages/bittune-core/tests"], {
	stdio: "inherit",
	cwd: resolve(import.meta.dirname, ".."),
});