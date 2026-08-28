import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
await cp("install/bootstrap.sh", join(stage, "install.sh"));
await chmod(join(stage, "install.sh"), 0o755);
await cp("install/requirements.txt", join(stage, "requirements.txt"));
await cp("README.md", join(stage, "README.md"));
await cp("README.en.md", join(stage, "README.en.md"));
await cp("LICENSE", join(stage, "LICENSE"));
await cp("THIRD_PARTY_NOTICES.md", join(stage, "THIRD_PARTY_NOTICES.md"));
await writeFile(join(stage, "manifest.json"), `${JSON.stringify({ version, package_type: "online", architecture: "linux-x86_64", node_version: "v22.22.2" }, null, 2)}\n`);
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
