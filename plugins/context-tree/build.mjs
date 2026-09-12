import { build } from "esbuild";
import { rm, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const at = (...parts) => join(root, ...parts);

await import("./scripts/generate-contracts.mjs");

await rm(at("dist"), { recursive: true, force: true });

const bundles = [
  { entry: ["src", "daemon.ts"], output: ["dist", "daemon.mjs"] },
  { entry: ["src", "mcp.ts"], output: ["dist", "mcp.mjs"] },
  { entry: ["src", "hook.ts"], output: ["dist", "hook.mjs"] },
  { entry: ["src", "shell.ts"], output: ["dist", "shell.mjs"] },
  { entry: ["test", "core.test.ts"], output: ["dist", "test", "core.test.mjs"] },
];

for (const bundle of bundles) {
  const entryPoint = at(...bundle.entry);
  const outfile = at(...bundle.output);

  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
  });
}

await copyFile(at("src", "compact-schema.json"), at("dist", "compact-schema.json"));
