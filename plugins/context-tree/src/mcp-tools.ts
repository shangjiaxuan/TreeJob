import { z } from "zod";
import { OperationSchemas, type OperationName } from "./schema.js";

const descriptions: Record<OperationName, string> = {
  hello: "Verify the daemon protocol version and schema digest.",
  describe: "Describe the generated protocol schemas.",
  pwd: "Show current path and work; initialize a session when cwd is supplied.",
  ls: "List direct children at a relative or absolute path.",
  cd: "Move the session cursor to a relative or absolute path.",
  mkdir: "Create a named child node while remaining in the current directory.",
  edit: "Patch the current node's work payload.",
  mv: "Move or rename a node using shell-style paths.",
  close: "Close the current node and return to its parent when possible.",
  search: "Search the current subtree by default; path targets a subtree without moving the cursor.",
  "rev-list": "List persistent revisions at the current node or an optional path.",
  "rev-show": "Show a revision on the current node or optional path's lineage.",
  fork: "Create a frozen child session from the current snapshot and cursor.",
  briefing: "Return compact recovery context for the active ancestry.",
  proposals: "List pending compact and subagent proposals.",
  "decide-proposal": "Accept, replace, reject, or discard a proposal.",
  "submit-proposal": "Internal hook operation for submitting candidate proposals.",
};

export const exposedOperations = [
  "pwd", "ls", "cd", "mkdir", "edit", "mv", "close", "search",
  "rev-list", "rev-show", "fork", "briefing", "proposals", "decide-proposal",
] as const satisfies readonly OperationName[];

const exposedOperationNames = new Set<string>(exposedOperations);

export const mcpTools = exposedOperations.map((name) => ({
  name,
  description: descriptions[name],
  inputSchema: z.toJSONSchema(OperationSchemas[name].input),
}));

export function isExposedOperation(value: string): value is OperationName {
  return exposedOperationNames.has(value);
}
