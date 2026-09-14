import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ContinuationController } from "../service/application/daemon-service.js";
import { mcpTools } from "./tool-definition.js";
import { CommandInputSchema } from "../../protocol/schema.js";
import { SERVICE_VERSION } from "../runtime/config.js";

const MetadataSchema = z.object({
  "context-tree/idempotency-key": z.string().min(1).optional(),
}).passthrough();

export async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  controller: ContinuationController,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = new Server(
    { name: "context-tree", version: SERVICE_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools }));
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    if (call.params.name !== "command") {
      return textResult("unknown Context Tree tool", true);
    }

    try {
      const input = CommandInputSchema.parse(call.params.arguments ?? {});
      const metadata = MetadataSchema.parse(call.params._meta ?? {});
      const result = controller.execute(input, metadata["context-tree/idempotency-key"]);
      return textResult(JSON.stringify(result));
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  });

  await server.connect(transport);
  await transport.handleRequest(request, response);
  await transport.close();
  await server.close();
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}
