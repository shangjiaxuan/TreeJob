import { randomUUID } from "node:crypto";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { CommandInputSchema, JsonSchema, type CommandInput } from "../protocol/schema.js";
import { openMcpConnection } from "./transport.js";

export class McpCommandError extends Error {}

export async function callCommand(
  raw: CommandInput,
  timeout = 8_000,
  idempotencyKey?: string,
): Promise<unknown> {
  const input = CommandInputSchema.parse(raw);
  const key = idempotencyKey ?? (input.sessionId ? randomUUID() : undefined);

  try {
    return await invoke(input, timeout, key);
  } catch (error) {
    if (error instanceof McpCommandError) {
      throw error;
    }

    return await invoke(input, timeout, key);
  }
}

async function invoke(input: CommandInput, timeout: number, key: string | undefined): Promise<unknown> {
  const connection = await openMcpConnection(timeout);

  try {
    const rawResult = await connection.client.callTool({
      name: "command",
      arguments: {
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        command: input.command,
      },
      ...(key ? { _meta: { "context-tree/idempotency-key": key } } : {}),
    }, CallToolResultSchema, { timeout });
    const result = CallToolResultSchema.parse(rawResult);
    const text = result.content.find((content) => content.type === "text");

    if (!text) {
      throw new McpCommandError("Context Tree MCP response did not contain text");
    }

    if (result.isError) {
      throw new McpCommandError(text.text);
    }

    return JsonSchema.parse(JSON.parse(text.text));
  } finally {
    await connection.close();
  }
}
