import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  OperationSchemas,
  PROTOCOL_VERSION,
  RpcFailureSchema,
  RpcSuccessSchema,
  schemaDigest,
  type OperationInput,
  type OperationName,
  type OperationOutput,
} from "./schema.js";

export function dataDir(): string {
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

export function endpoint(directory = dataDir()): string {
  if (platform() === "win32") {
    const digest = createHash("sha256")
      .update(directory)
      .digest("hex")
      .slice(0, 20);

    return "\\\\.\\pipe\\context-tree-" + digest;
  }

  return join(directory, "daemon.sock");
}

export function daemonEntry(): string {
  return fileURLToPath(new URL("./daemon.mjs", import.meta.url));
}

export async function call<N extends OperationName>(
  method: N,
  params: OperationInput<N>,
  timeout = 8_000,
): Promise<OperationOutput<N>> {
  const directory = dataDir();
  mkdirSync(directory, { recursive: true });

  try {
    await hello();
    const response = await send(method, params, timeout);
    return parseOperationOutput(method, response);
  } catch {
    await startDaemon(directory);
    const response = await send(method, params, timeout);
    return parseOperationOutput(method, response);
  }
}

function send<N extends OperationName>(
  method: N,
  params: OperationInput<N>,
  timeout: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = net.createConnection(endpoint());
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("daemon timeout"));
    }, timeout);
    let bufferedText = "";

    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    socket.on("connect", () => {
      socket.write(JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        id,
        method,
        params,
      }) + "\n");
    });

    socket.on("data", (chunk) => {
      bufferedText += chunk.toString();
      const newline = bufferedText.indexOf("\n");

      if (newline < 0) {
        return;
      }

      clearTimeout(timer);
      socket.end();

      try {
        const raw = JSON.parse(bufferedText.slice(0, newline));
        const failure = RpcFailureSchema.safeParse(raw);

        if (failure.success) {
          throw new Error(
            failure.data.error.code + ": " + failure.data.error.message,
          );
        }

        const success = RpcSuccessSchema.parse(raw);
        resolve(success.result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseOperationOutput<N extends OperationName>(
  method: N,
  raw: unknown,
): OperationOutput<N> {
  // TypeScript cannot preserve an indexed Zod schema's relation to a generic
  // key. This is the single protocol-registry bridge; Zod still validates the
  // runtime value before it crosses the RPC boundary.
  const outputSchema = OperationSchemas[method].output as unknown as z.ZodType<
    OperationOutput<N>
  >;

  return outputSchema.parse(raw);
}

async function hello(): Promise<void> {
  const response = await send(
    "hello",
    {
      protocolVersion: PROTOCOL_VERSION,
      schemaDigest,
    },
    2_000,
  );

  parseOperationOutput("hello", response);
}

async function startDaemon(directory: string): Promise<void> {
  const lockDirectory = join(directory, "daemon-v1.start.lock");
  const ownsLock = acquireStartLock(lockDirectory);

  if (ownsLock) {
    const child = spawn(
      process.execPath,
      [daemonEntry()],
      {
        detached: true,
        stdio: "ignore",
        env: process.env,
      },
    );
    child.unref();
  }

  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    try {
      await hello();
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, 75);
      });
    }
  }

  try {
    rmSync(lockDirectory, { recursive: true, force: true });
  } catch {
    // A concurrent daemon owner may have already released the lock.
  }

  throw new Error("unable to start Context Tree daemon");
}

function acquireStartLock(lockDirectory: string): boolean {
  try {
    mkdirSync(lockDirectory);
    return true;
  } catch {
    return false;
  }
}

export function releaseStartLock(): void {
  const lockDirectory = join(dataDir(), "daemon-v1.start.lock");

  try {
    rmSync(lockDirectory, { recursive: true, force: true });
  } catch {
    // The daemon may have been started by a client that already cleaned up.
  }
}
