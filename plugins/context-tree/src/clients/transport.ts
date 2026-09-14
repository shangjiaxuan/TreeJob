import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEFAULT_PORT = 43_177;

export type McpConnection = {
  client: Client;
  close(): Promise<void>;
};

export async function openMcpConnection(timeout = 8_000): Promise<McpConnection> {
  const endpoint = configuredEndpoint();

  try {
    return await connect(endpoint, timeout);
  } catch (error) {
    if (process.env.CONTEXT_TREE_MCP_ENDPOINT) {
      throw error;
    }

    startDaemon();
    return await retry(endpoint, timeout);
  }
}

export function configuredEndpoint(): URL {
  const explicit = process.env.CONTEXT_TREE_MCP_ENDPOINT;

  if (explicit) {
    const value = new URL(explicit);

    if (
      value.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(value.hostname) ||
      value.pathname !== "/mcp"
    ) {
      throw new Error("CONTEXT_TREE_MCP_ENDPOINT must be a loopback http:// URL ending in /mcp");
    }

    return value;
  }

  const port = Number(process.env.CONTEXT_TREE_MCP_PORT ?? String(DEFAULT_PORT));

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("CONTEXT_TREE_MCP_PORT must be an integer from 0 to 65535");
  }

  if (port === 0) {
    throw new Error("CONTEXT_TREE_MCP_ENDPOINT is required when CONTEXT_TREE_MCP_PORT=0");
  }

  return new URL("http://127.0.0.1:" + port + "/mcp");
}

async function connect(endpoint: URL, timeout: number): Promise<McpConnection> {
  const transport = new StreamableHTTPClientTransport(endpoint);
  const client = new Client({ name: "context-tree-client", version: "0.8.0" });
  await client.connect(transport, { timeout });
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

async function retry(endpoint: URL, timeout: number): Promise<McpConnection> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await connect(endpoint, timeout);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("unable to start Context Tree daemon");
}

function startDaemon(): void {
  const child = spawn(process.execPath, [daemonEntry()], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

function daemonEntry(): string {
  return fileURLToPath(new URL("./daemon.mjs", import.meta.url));
}
