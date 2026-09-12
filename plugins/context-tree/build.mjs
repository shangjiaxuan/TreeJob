import { build } from "esbuild";
import { rm, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const at = (...parts) => join(root, ...parts);

await import("./scripts/generate-contracts.mjs");

await rm(at("dist"), { recursive: true, force: true });
await Promise.all([
  build({ entryPoints: [at("src", "daemon.ts")], outfile: at("dist", "daemon.mjs"), bundle: true, platform: "node", format: "esm", target: "node22" }),
  build({ entryPoints: [at("src", "mcp.ts")], outfile: at("dist", "mcp.mjs"), bundle: true, platform: "node", format: "esm", target: "node22" }),
  build({ entryPoints: [at("src", "hook.ts")], outfile: at("dist", "hook.mjs"), bundle: true, platform: "node", format: "esm", target: "node22" }),
  build({ entryPoints: [at("src", "shell.ts")], outfile: at("dist", "shell.mjs"), bundle: true, platform: "node", format: "esm", target: "node22" }),
  build({ entryPoints: [at("test", "core.test.ts")], outfile: at("dist", "test", "core.test.mjs"), bundle: true, platform: "node", format: "esm", target: "node22" })
]);
await copyFile(at("src", "compact-schema.json"), at("dist", "compact-schema.json"));
