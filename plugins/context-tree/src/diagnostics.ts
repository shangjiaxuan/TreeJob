import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./rpc.js";

export function writeDiagnostic(event: Record<string, unknown>): void {
  if (process.env.CONTEXT_TREE_DEBUG !== "1") return;
  const directory = dataDir();
  mkdirSync(directory, { recursive: true });
  appendFileSync(join(directory, "context-tree-debug.jsonl"), JSON.stringify({
    timestamp: new Date().toISOString(),
    ...event,
  }) + "\n");
}
