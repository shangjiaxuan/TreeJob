import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  mcpTools,
} from "./mcp-tools.js";
import { callCommand } from "./rpc.js";
import { CommandInputSchema } from "./schema.js";

const server = new Server(
  {
    name: "context-tree",
    version: "3.0.0",
  },
  {
    capabilities: { tools: {} },
    instructions: [
      "Context Tree stores explicit continuation state.",
      "Read pwd or briefing before broad searches.",
      "Decide pending compact proposals before mutating the tree.",
    ].join(" "),
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: mcpTools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "command") {
    return {
      content: [{
        type: "text",
        text: "unknown Context Tree tool",
      }],
      isError: true,
    };
  }

  try {
    const input = CommandInputSchema.parse(
      request.params.arguments ?? {},
    );
    const result = await callCommand(input);

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
