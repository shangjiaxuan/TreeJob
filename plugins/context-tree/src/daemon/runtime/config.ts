import { homedir, platform } from "node:os";
import { join } from "node:path";

export const DEFAULT_MCP_PORT = 43_177;
export const SERVICE_VERSION = "0.8.0";

export type DaemonConfiguration = {
  dataDirectory: string;
  runtimeDirectory: string;
  port: number;
};

export function dataDirectory(): string {
  if (process.env.CONTEXT_TREE_DATA_DIR) {
    return process.env.CONTEXT_TREE_DATA_DIR;
  }

  if (platform() === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "ContextTree",
    );
  }

  return join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "context-tree",
  );
}

export function databaseFile(directory = dataDirectory()): string {
  return join(directory, "context-tree-v7.sqlite");
}

export function runtimeDirectory(): string {
  // Tests may run isolated daemon fixtures in parallel. Production deliberately
  // has no equivalent override: all normal clients share one user-local lease.
  if (process.env.CONTEXT_TREE_TEST_RUNTIME_DIR) {
    return process.env.CONTEXT_TREE_TEST_RUNTIME_DIR;
  }

  if (platform() === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "ContextTree",
    );
  }

  return join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "context-tree",
  );
}

export function daemonConfiguration(args: readonly string[]): DaemonConfiguration {
  return {
    dataDirectory: dataDirectory(),
    runtimeDirectory: runtimeDirectory(),
    port: parsePort(args),
  };
}

export function endpointForPort(port: number): URL {
  return new URL("http://127.0.0.1:" + port + "/mcp");
}

function parsePort(args: readonly string[]): number {
  let explicit: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--port") {
      throw new Error("Usage: context-tree-daemon [--port <0-65535>]");
    }

    explicit = args[index + 1];
    index += 1;
  }

  return port(explicit ?? process.env.CONTEXT_TREE_MCP_PORT ?? String(DEFAULT_MCP_PORT));
}

function port(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("CONTEXT_TREE_MCP_PORT must be an integer from 0 to 65535");
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error("CONTEXT_TREE_MCP_PORT must be an integer from 0 to 65535");
  }

  return parsed;
}
