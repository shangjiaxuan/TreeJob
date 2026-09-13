import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { readBrowserView } from "./browse-data.js";
import { renderBrowsePage, renderLoginPage } from "./browse-view.js";

const cookieName = "context_tree_session";
const options = parseOptions(process.argv.slice(2));

if (options.dataDir !== null) {
  process.env.CONTEXT_TREE_DATA_DIR = options.dataDir;
}

const server = createServer((request, response) => {
  void handle(request, response);
});

server.listen(options.port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null
    ? address.port
    : options.port;
  process.stdout.write("Context Tree browser: http://127.0.0.1:" + actualPort + "/\n");
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET") {
    respond(response, 405, "Method not allowed", "text/plain; charset=utf-8");
    return;
  }

  const target = new URL(request.url ?? "/", "http://127.0.0.1");

  if (target.pathname === "/logout") {
    response.setHeader("Set-Cookie", cookieName + "=; Path=/; Max-Age=0; SameSite=Strict; HttpOnly");
    redirect(response, "/");
    return;
  }

  if (target.pathname === "/login") {
    const sessionId = target.searchParams.get("sessionId")?.trim() ?? "";

    if (sessionId.length === 0) {
      html(response, 400, renderLoginPage("A session ID is required."));
      return;
    }

    response.setHeader(
      "Set-Cookie",
      cookieName + "=" + encodeURIComponent(sessionId) + "; Path=/; SameSite=Strict; HttpOnly",
    );
    redirect(response, "/browse/");
    return;
  }

  const sessionId = cookie(request, cookieName);

  if (!sessionId) {
    if (target.pathname === "/" || target.pathname.startsWith("/browse")) {
      html(response, 200, renderLoginPage());
      return;
    }

    respond(response, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }

  if (target.pathname === "/") {
    redirect(response, "/browse/");
    return;
  }

  if (!target.pathname.startsWith("/browse/")) {
    respond(response, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }

  try {
    const path = decodePath(target.pathname.slice("/browse".length));
    const revisionId = parseRevision(target.searchParams.get("revision"));
    const result = await readBrowserView(sessionId, path, revisionId);
    html(response, 200, renderBrowsePage(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    html(response, 400, renderLoginPage("Browse error: " + message));
  }
}

function parseOptions(args: string[]): { port: number; dataDir: string | null } {
  let port = 0;
  let hasPort = false;
  let dataDir: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];

    if (!name || !value || !["--port", "--data-dir"].includes(name)) {
      throw new Error("Usage: context-tree-browse [--data-dir <directory>] [--port <0-65535>]");
    }

    if (name === "--port") {
      if (hasPort) {
        throw new Error("--port was specified twice");
      }

      port = parsePort(value);
      hasPort = true;
    } else {
      if (dataDir !== null) {
        throw new Error("--data-dir was specified twice");
      }

      dataDir = value;
    }

    index += 1;
  }

  return { port, dataDir };
}

function parsePort(raw: string): number {
  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error("port must be an integer from 0 to 65535");
  }

  return value;
}

function parseRevision(raw: string | null): number | undefined {
  if (raw === null || raw.length === 0) {
    return undefined;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error("revision must be an integer");
  }

  return Number(raw);
}

function decodePath(raw: string): string {
  const decoded = decodeURIComponent(raw);
  return decoded === "" ? "/" : decoded;
}

function cookie(request: IncomingMessage, name: string): string | null {
  const source = request.headers.cookie;

  if (!source) {
    return null;
  }

  for (const fragment of source.split(";")) {
    const [key, ...value] = fragment.trim().split("=");

    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }

  return null;
}

function html(response: ServerResponse, status: number, body: string): void {
  respond(response, status, body, "text/html; charset=utf-8");
}

function respond(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { Location: location });
  response.end();
}
