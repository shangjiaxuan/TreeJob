import { access, readFile } from "node:fs/promises";

const required = [".codex-plugin/plugin.json", ".mcp.json", "hooks/hooks.json", "skills/context-tree/SKILL.md", "dist/mcp.mjs", "dist/daemon.mjs", "dist/hook.mjs"];
for (const path of required) await access(path);
const manifest = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
if (manifest.name !== "context-tree" || !manifest.mcpServers || !manifest.skills) throw new Error("invalid Context Tree plugin manifest");
console.log("context-tree plugin layout valid");
