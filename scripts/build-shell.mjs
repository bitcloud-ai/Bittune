import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const photonSrc = "node_modules/@silvia-odwyer/photon-node";
const photonDest = "dist/node_modules/@silvia-odwyer/photon-node";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["packages/bittune-runtime/src/bittune.ts"],
  outfile: "dist/bittune.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["@silvia-odwyer/photon-node"],
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __bittuneCreateRequire } from "node:module"; const require = __bittuneCreateRequire(import.meta.url);',
  },
  legalComments: "inline",
});
await mkdir("dist/modes/interactive/theme", { recursive: true });
await Promise.all(
	["dark.json", "light.json"].map((name) =>
		cp(`packages/bittune-runtime/src/modes/interactive/theme/${name}`, `dist/modes/interactive/theme/${name}`),
	),
);
await mkdir("dist/node_modules/@silvia-odwyer", { recursive: true });
await cp(photonSrc, photonDest, { recursive: true });
await cp("packages/bittune-runtime/skills", "dist/skills", { recursive: true });
