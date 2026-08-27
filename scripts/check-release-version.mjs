import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const tag = process.env.GITHUB_REF_NAME?.trim();
if (tag && tag !== `v${packageJson.version}`) {
  throw new Error(`Release tag ${tag} does not match package version v${packageJson.version}.`);
}
console.log(tag ? `Release tag ${tag} matches package version.` : `Package version is ${packageJson.version}; no release tag to verify.`);
