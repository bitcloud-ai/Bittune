import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const version = pkg.version;
const release = "release";
await rm(release, { recursive: true, force: true });
await mkdir(release, { recursive: true });

const onlineName = `bittune-${version}-linux-x86_64`;
const stage = join(release, onlineName);
const agent = join(stage, "agent");
await mkdir(agent, { recursive: true });
	await cp("dist", join(agent, "dist"), { recursive: true });
	await cp("package.json", join(agent, "package.json"));
	await cp("package-lock.json", join(agent, "package-lock.json"));
	await cp("packages/bittune-runtime/skills", join(agent, "skills"), { recursive: true });
await cp("packages/bittune-core", join(stage, "core"), {
	recursive: true,
	filter: (source) => !source.includes("__pycache__") && !source.includes(`${join("packages", "bittune-core", "tests")}`),
});
await cp("install/bootstrap.sh", join(stage, "install.sh"));
await chmod(join(stage, "install.sh"), 0o755);
await cp("install/requirements.txt", join(stage, "requirements.txt"));
await cp("README.md", join(stage, "README.md"));
await cp("README.en.md", join(stage, "README.en.md"));
await cp("LICENSE", join(stage, "LICENSE"));
await cp("THIRD_PARTY_NOTICES.md", join(stage, "THIRD_PARTY_NOTICES.md"));
await cp("guide", join(stage, "guide"), { recursive: true });
await cp("ROADMAP.md", join(stage, "ROADMAP.md"));
await cp("ROADMAP.en.md", join(stage, "ROADMAP.en.md"));
const corePayload = ["pyproject.toml", join("src", "bittune_core", "__init__.py"), join("src", "bittune_core", "__main__.py")];
for (const path of corePayload) {
	if (!existsSync(join(stage, "core", path))) throw new Error(`Core payload is incomplete: missing core/${path}`);
}
// Build Core once and collect its runtime closure for offline target installs.
{
	const python = resolveBuildPython();
	const wheelDir = join(stage, "core-wheel");
	await mkdir(wheelDir, { recursive: true });
	try {
		execFileSync(python, ["-m", "pip", "wheel", "--no-deps", "--wheel-dir", wheelDir, "packages/bittune-core"], { stdio: "inherit" });
		for (const minor of ["3.10", "3.11", "3.12", "3.13", "3.14"]) {
			execFileSync(python, ["-m", "pip", "download", "--only-binary=:all:",
				"--implementation", "cp", "--python-version", minor, "--abi", `cp${minor.replace(".", "")}`,
				"--platform", "manylinux_2_17_x86_64", "--platform", "manylinux_2_28_x86_64",
				"--dest", wheelDir, "-r", "install/core-requirements.txt"], { stdio: "inherit" });
		}
	} catch (error) {
		throw new Error(`Python Core wheelhouse build failed (${python} -m pip wheel/download ...). Set BITTUNE_BUILD_PYTHON to a Python with pip and check the target wheels.`, { cause: error });
	}
		const wheels = (await readdir(wheelDir)).filter((name) => /^bittune_core-\d+\.\d+\.\d+-py3-none-any\.whl$/.test(name));
		if (wheels.length !== 1) throw new Error(`Expected exactly one bittune_core wheel in the release payload, found ${wheels.length}.`);
		const listing = execFileSync(python, ["-c", "import zipfile,sys; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", join(wheelDir, wheels[0])], { encoding: "utf8" });
		if (!listing.includes("bittune_core/data/gpu_products.json")) {
			throw new Error("bittune_core wheel is missing data/gpu_products.json; package-data must ship the GPU product table.");
		}
		if (process.platform === "linux" && process.arch === "x64") {
			execFileSync(process.execPath, ["--import", "tsx", "scripts/verify-core-wheelhouse.mjs", wheelDir], { stdio: "inherit" });
		}
	}

/** Ubuntu 24.04 ships `python3` only; Windows usually has `python`. */
function resolveBuildPython() {
	if (process.env.BITTUNE_BUILD_PYTHON?.trim()) return process.env.BITTUNE_BUILD_PYTHON.trim();
	const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
	for (const candidate of candidates) {
		try {
			const probe = execFileSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
			if (probe.trim()) return candidate;
		} catch {
			// keep probing
		}
	}
	throw new Error("未找到可用的 Python 解释器；设置 BITTUNE_BUILD_PYTHON 指向带 pip 的 Python。");
}
await writeFile(join(stage, "manifest.json"), `${JSON.stringify({ version, package_type: "online", architecture: "linux-x86_64", node_version: "v22.22.2", core: "src", core_wheel: "prebuilt" }, null, 2)}\n`);
execFileSync(process.execPath, ["scripts/generate-sbom.mjs", join(stage, "bittune-sbom.cdx.json")], { stdio: "inherit" });
await cp(join(stage, "bittune-sbom.cdx.json"), join(release, `${onlineName}-sbom.cdx.json`));
execFileSync(process.platform === "win32" ? "tar.exe" : "tar", ["-czf", join(release, `${onlineName}.tar.gz`), "-C", release, onlineName], { stdio: "inherit" });
await rm(stage, { recursive: true, force: true });
if (process.platform !== "win32") {
  execFileSync("bash", ["install/build-offline-bundle.sh", join(release, `${onlineName}.tar.gz`), release], { stdio: "inherit" });
}
execFileSync(process.platform === "win32" ? "powershell.exe" : "bash", process.platform === "win32"
  ? ["-NoProfile", "-Command", `Get-FileHash '${join(release, `${onlineName}.tar.gz`)}' -Algorithm SHA256 | ForEach-Object { $_.Hash.ToLower() + '  ${onlineName}.tar.gz' } | Set-Content '${join(release, `${onlineName}.sha256`)}'`]
  : ["-c", `cd ${JSON.stringify(release)} && sha256sum ${onlineName}.tar.gz ${onlineName}-offline.tar.gz 2>/dev/null > ${onlineName}.sha256 || sha256sum ${onlineName}.tar.gz > ${onlineName}.sha256`], { stdio: "inherit" });
console.log(join(release, `${onlineName}.tar.gz`));
