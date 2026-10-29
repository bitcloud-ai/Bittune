// Suite contract is owned by packages/bittune-core contracts.py.
// This script only checks that the exported tuples are non-empty and disjoint
// from a second handwritten copy. It does not embed the word lists.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.BITTUNE_PYTHON || "python";
const exported = spawnSync(
	python,
	["-m", "bittune_core.suite_contract_export"],
	{
		cwd: repoRoot,
		env: {
			...process.env,
			PYTHONPATH: join(repoRoot, "packages", "bittune-core", "src"),
		},
		encoding: "utf8",
	},
);
if (exported.status !== 0) {
	console.error(exported.stderr || exported.stdout);
	process.exit(1);
}
const contract = JSON.parse(exported.stdout);
const required = [
	"row_states",
	"row_required_fields",
	"suite_claim_metrics",
	"pd_claim_metrics",
	"workbook_detail_columns",
	"workbook_best_columns",
	"workbook_pd_columns",
];
for (const key of required) {
	if (!Array.isArray(contract[key]) || contract[key].length === 0) {
		console.error(`suite contract export missing ${key}`);
		process.exit(1);
	}
}
const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
const leaked = contract.row_states.filter((state) => source.includes(`"${state}"`));
if (leaked.length > 0) {
	console.error(`check-suite-contract.mjs copied row states: ${leaked.join(", ")}`);
	process.exit(1);
}
console.log("suite contract export ok");
