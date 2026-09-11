import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { call } from "./rpc.js";
import { OperationSchemas, type OperationName } from "./schema.js";

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

const exposedOperations = [
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
const server = new Server(
  {
    name: "context-tree",
    version: "1.0.0",
  },
  {
    capabilities: { tools: {} },
    instructions: [
      "Context Tree stores explicit continuation state.",
      "Read getContext before broad searches.",
      "Decide pending compact proposals before mutating the tree.",
    ].join(" "),
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: exposedOperations.map((name) => ({
    name,
    description: descriptions[name],
    inputSchema: z.toJSONSchema(OperationSchemas[name].input),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const operation = request.params.name;

  if (!isExposedOperation(operation)) {
    return {
      content: [{
        type: "text",
        text: "unknown Context Tree tool",
      }],
      isError: true,
    };
  }

  try {
    const input = OperationSchemas[operation].input.parse(
      request.params.arguments ?? {},
    );
    const result = await call(operation, input);

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());

function isExposedOperation(value: string): value is OperationName {
  return exposedOperationNames.has(value);
}
