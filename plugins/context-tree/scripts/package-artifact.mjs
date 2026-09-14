import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(pluginRoot));
const artifactRoot = join(repositoryRoot, "out", "context-tree-marketplace");
const stagedPlugin = join(artifactRoot, "plugins", "context-tree");
const stagedMarketplace = join(artifactRoot, ".agents", "plugins", "marketplace.json");

await rm(artifactRoot, { recursive: true, force: true });
await mkdir(dirname(stagedPlugin), { recursive: true });
await cp(pluginRoot, stagedPlugin, {
  recursive: true,
  filter(source) {
    const path = relative(pluginRoot, source).replaceAll("\\", "/");
    return ![
      "node_modules",
      "dist",
      "src/generated",
    ].some((ignored) => path === ignored || path.startsWith(ignored + "/"));
  },
});

const marketplace = JSON.parse(await readFile(join(repositoryRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
await mkdir(dirname(stagedMarketplace), { recursive: true });
await writeFile(stagedMarketplace, JSON.stringify(marketplace, null, 2) + "\n");

const npm = process.platform === "win32" && process.env.npm_execpath
  ? process.execPath
  : process.platform === "win32" ? "npm.cmd" : "npm";
run(["ci"]);
run(["run", "build"]);
run(["test"]);
run(["run", "validate"]);

await rm(join(stagedPlugin, "node_modules"), { recursive: true, force: true });
await rm(join(stagedPlugin, "dist", "test"), { recursive: true, force: true });

console.log("staged Context Tree marketplace: " + artifactRoot);

function run(arguments_) {
  const commandArguments = npm === process.execPath && process.env.npm_execpath
    ? [process.env.npm_execpath, ...arguments_]
    : arguments_;
  execFileSync(npm, commandArguments, {
    cwd: stagedPlugin,
    stdio: "inherit",
    ...(npm === "npm.cmd" ? { shell: true } : {}),
  });
}
