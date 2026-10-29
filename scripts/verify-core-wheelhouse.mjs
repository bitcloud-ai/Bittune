// A clean offline install through the production component, without changing
// the global launcher or an existing Bittune installation.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COMPONENTS } from "../packages/bittune-runtime/src/cli/install/components.ts";

const root = await mkdtemp(join(tmpdir(), "bittune-wheelhouse-"));
const python = process.env.BITTUNE_BUILD_PYTHON || "python3";
const context = {
	installRoot: root, targetUser: "root", sourceKind: "bundle", payloadPath: root,
	coreWheelDir: resolve(process.argv[2]), appendLog: (text) => process.stdout.write(text),
};
try {
	execFileSync(python, ["-m", "venv", join(root, "py")], { stdio: "inherit" });
	await mkdir(join(root, "agent"));
	const component = COMPONENTS.find((entry) => entry.id === "bittune-core");
	await component.install(context);
	console.log(await component.verify(context));
	execFileSync(join(root, "py", "bin", "python"), ["-m", "pip", "check"], { stdio: "inherit" });
	console.log("Clean offline Core installation passed");
} finally {
	await rm(root, { recursive: true, force: true });
}
