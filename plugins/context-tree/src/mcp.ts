import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  isExposedOperation,
  mcpTools,
} from "./mcp-tools.js";
import { call } from "./rpc.js";
import { OperationSchemas } from "./schema.js";

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
  tools: mcpTools,
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
