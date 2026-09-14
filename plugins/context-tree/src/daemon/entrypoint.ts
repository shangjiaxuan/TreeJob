import { createServer } from "node:http";
import { handleMcpRequest } from "./mcp/server.js";
import { daemonConfiguration, databaseFile, endpointForPort } from "./runtime/config.js";
import { DaemonLaunchGate, DaemonRegistryOwner } from "./runtime/registry.js";
import { ContinuationController } from "./service/application/daemon-service.js";
import { SqliteRecordRepository } from "./service/persistence/record-repository.js";

const configuration = daemonConfiguration(process.argv.slice(2));
const launchGate = new DaemonLaunchGate(configuration.runtimeDirectory);

if (!launchGate.acquire()) {
  process.exit(0);
}

const registry = new DaemonRegistryOwner(
  configuration.dataDirectory,
  configuration.runtimeDirectory,
);

if (!registry.acquire()) {
  launchGate.close();
  process.exit(0);
}

const controller = new ContinuationController(
  new SqliteRecordRepository(databaseFile(configuration.dataDirectory)),
);
let activeRequests = 0;
let idleTimer: NodeJS.Timeout | undefined;

const server = createServer((request, response) => {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  if (request.url !== "/mcp") {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Context Tree MCP endpoint is /mcp");
    return;
  }

  activeRequests += 1;
  let completed = false;
  const complete = () => {
    if (completed) {
      return;
    }

    completed = true;
    activeRequests -= 1;

    if (activeRequests === 0) {
      idleTimer = setTimeout(shutdown, process.env.CONTEXT_TREE_EPHEMERAL === "1" ? 150 : 60_000);
    }
  };

  response.once("finish", complete);
  response.once("close", complete);
  void handleMcpRequest(request, response, controller).catch((error: unknown) => {
    if (!response.headersSent) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    }
    response.end(error instanceof Error ? error.message : String(error));
  });
});

server.once("error", (error) => {
  launchGate.close();
  registry.close();
  controller.dispose();
  process.stderr.write("Context Tree daemon failed: " + error.message + "\n");
  process.exitCode = 1;
});

server.listen(configuration.port, "127.0.0.1", () => {
  const address = server.address();

  if (typeof address !== "object" || address === null) {
    throw new Error("Context Tree daemon did not receive a TCP address");
  }

  registry.publish(endpointForPort(address.port));
  launchGate.close();
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function shutdown(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  server.close(() => {
    controller.dispose();
    registry.close();
    launchGate.close();
    process.exit(0);
  });
}
