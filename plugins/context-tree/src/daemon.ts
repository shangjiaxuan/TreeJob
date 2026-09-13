/** Local socket framing and daemon lifetime only. */
import net from "node:net";
import { existsSync, rmSync } from "node:fs";
import { FilesystemOperations } from "./daemon-service.js";
import { endpoint, releaseStartLock } from "./rpc.js";
import {
  PROTOCOL_VERSION,
  RpcRequestSchema,
} from "./schema.js";

const controller = new FilesystemOperations();
const socketEndpoint = endpoint();

if (process.platform !== "win32" && existsSync(socketEndpoint)) {
  rmSync(socketEndpoint, { force: true });
}

let clientCount = 0;
let idleTimer: NodeJS.Timeout | undefined;

const server = net.createServer((socket) => {
  clientCount += 1;

  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  let bufferedText = "";

  socket.on("data", (chunk) => {
    bufferedText += chunk.toString();

    for (;;) {
      const newline = bufferedText.indexOf("\n");

      if (newline < 0) {
        break;
      }

      const line = bufferedText.slice(0, newline);
      bufferedText = bufferedText.slice(newline + 1);
      writeResponse(socket, line);
    }
  });

  socket.on("close", () => {
    clientCount -= 1;

    if (clientCount === 0) {
      idleTimer = setTimeout(() => server.close(), 60_000);
    }
  });
});

server.listen(socketEndpoint, () => {
  releaseStartLock();
});

server.on("close", () => {
  if (process.platform !== "win32" && existsSync(socketEndpoint)) {
    rmSync(socketEndpoint, { force: true });
  }

  process.exit(0);
});

process.on("SIGTERM", () => {
  server.close();
});

function writeResponse(socket: net.Socket, line: string): void {
  let id = "unknown";

  try {
    const request = RpcRequestSchema.parse(JSON.parse(line));
    id = request.id;
    const result = request.method === "hello"
      ? controller.hello(request.params)
      : controller.execute(request.params, request.idempotencyKey);
    socket.write(JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      id,
      ok: true,
      result,
    }) + "\n");
  } catch (error) {
    socket.write(JSON.stringify(controller.failure(id, error)) + "\n");
  }
}
