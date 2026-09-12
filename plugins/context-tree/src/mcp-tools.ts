import { z } from "zod";
import {
  OperationSchemas,
  type OperationName,
} from "./schema.js";

const descriptions: Record<OperationName, string> = {
  hello: "Verify the strict daemon protocol version and schema digest.",
  describe: "Describe generated Context Tree protocol schemas.",
  registerSession: "Register or restore a root continuation session.",
  getContext: "Read the active cursor, tree path, and proposals.",
  searchContext: "Search current snapshot heads by scope.",
  searchHistory: "Search immutable history explicitly.",
  pushChild: "Create a returnable child record below the active cursor.",
  addSibling: "Create a returnable sibling record.",
  enter: "Enter a direct child inode.",
  back: "Return cursor to parent.",
  updateRecord: "COW-update a payload inode.",
  closeRecord: "Close a terminal record.",
  forkSession: "Fork exact tree snapshot and cursor state.",
  createProposal: "Create an immutable compact, subagent, or manual candidate.",
  listProposals: "List pending proposals.",
  decideProposal: "Accept an existing candidate, write a replacement, reject, or discard.",
};

export const exposedOperations = [
  "registerSession",
  "getContext",
  "searchContext",
  "searchHistory",
  "pushChild",
  "addSibling",
  "enter",
  "back",
  "updateRecord",
  "closeRecord",
  "forkSession",
  "createProposal",
  "listProposals",
  "decideProposal",
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
