import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openMcpConnection } from "../transport.js";

const server = new Server(
  { name: "context-tree-stdio-bridge", version: "0.8.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const connection = await openMcpConnection();

  try {
    return await connection.client.listTools();
  } finally {
    await connection.close();
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const connection = await openMcpConnection();

  try {
    return await connection.client.callTool(request.params);
  } finally {
    await connection.close();
  }
});

await server.connect(new StdioServerTransport());
