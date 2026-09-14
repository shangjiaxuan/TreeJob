import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ContinuationController } from "../src/daemon/service/application/daemon-service.js";
import { SqliteRecordRepository } from "../src/daemon/service/persistence/record-repository.js";
import { DaemonLaunchGate, DaemonRegistryOwner } from "../src/daemon/runtime/registry.js";
import { configuredEndpoint } from "../src/clients/transport.js";

type Context = {
  controller: ContinuationController;
  directory: string;
  cleanup(): void;
};

function createContext(): Context {
  const directory = mkdtempSync(join(tmpdir(), "context-tree-test-"));
  const repository = new SqliteRecordRepository(join(directory, "context-tree.sqlite"));
  return {
    controller: new ContinuationController(repository),
    directory,
    cleanup() {
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function command(controller: ContinuationController, sessionId: string, argv: unknown[], key?: string): any {
  return controller.execute({ sessionId, command: argv }, key);
}

test("pwd is detailed while mutations return compact affected-state acknowledgements", () => {
  const context = createContext();
  try {
    const pwd = command(context.controller, "session", ["pwd", "C:/work"]);
    assert.equal(pwd.current_dir.path, "/");
    assert.equal(pwd.current_work.status, "open");

    const mkdir = command(context.controller, "session", ["mkdir", "detour", {
      objective: "Investigate",
      rationale: "A test requires it",
      returnCondition: "Report result",
    }]);
    assert.equal(mkdir.created.path, "/detour");
    assert.equal(mkdir.current_work, undefined);

    const cd = command(context.controller, "session", ["cd", "detour"]);
    assert.equal(cd.movedTo, "/detour");

    const edit = command(context.controller, "session", ["edit", { currentState: "Running test" }]);
    assert.deepEqual(edit.updated, { path: "/detour", fields: ["currentState"] });
  } finally {
    context.cleanup();
  }
});

test("session events use one validated JSON document with indexed revisions", () => {
  const context = createContext();
  let database: DatabaseSync | undefined;

  try {
    command(context.controller, "session", ["pwd", "C:/work"]);
    command(context.controller, "session", ["edit", { currentState: "recorded" }]);
    database = new DatabaseSync(join(context.directory, "context-tree.sqlite"));
    const columns = database.prepare("PRAGMA table_info(session_events_v7)").all() as Array<{ name: string }>;
    const event = database.prepare(
      "SELECT revision,event_json FROM session_events_v7 WHERE session_id=? AND revision=?",
    ).get("session", 1) as { revision: number; event_json: string } | undefined;
    assert.deepEqual(columns.map((column) => column.name), ["sequence", "session_id", "revision", "event_json"]);
    assert.equal(event?.revision, 1);
    assert.equal(JSON.parse(event?.event_json ?? "{}").action, "edit");
  } finally {
    database?.close();
    context.cleanup();
  }
});

test("clients require an explicit endpoint for a dynamic daemon port", () => {
  const previousPort = process.env.CONTEXT_TREE_MCP_PORT;
  const previousEndpoint = process.env.CONTEXT_TREE_MCP_ENDPOINT;

  try {
    process.env.CONTEXT_TREE_MCP_PORT = "0";
    delete process.env.CONTEXT_TREE_MCP_ENDPOINT;
    assert.throws(() => configuredEndpoint(), /ENDPOINT is required/);

    process.env.CONTEXT_TREE_MCP_ENDPOINT = "http://127.0.0.1:45123/mcp";
    assert.equal(configuredEndpoint().toString(), "http://127.0.0.1:45123/mcp");

    process.env.CONTEXT_TREE_MCP_ENDPOINT = "http://example.test/mcp";
    assert.throws(() => configuredEndpoint(), /loopback/);
  } finally {
    restoreEnvironment("CONTEXT_TREE_MCP_PORT", previousPort);
    restoreEnvironment("CONTEXT_TREE_MCP_ENDPOINT", previousEndpoint);
  }
});

test("daemon ownership and startup are exclusive across data directories", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-tree-registry-test-"));
  const runtime = join(directory, "runtime");
  const first = new DaemonRegistryOwner(join(directory, "first-data"), runtime);
  const second = new DaemonRegistryOwner(join(directory, "second-data"), runtime);
  const firstLaunch = new DaemonLaunchGate(runtime);
  const secondLaunch = new DaemonLaunchGate(runtime);

  try {
    assert.equal(first.acquire(), true);
    assert.equal(second.acquire(), false);
    first.close();
    writeFileSync(join(runtime, "daemon-v7.json"), JSON.stringify({
      endpoint: "http://127.0.0.1:45124/mcp",
      pid: 999_999,
      dataDirectoryFingerprint: "stale",
      serviceVersion: "0.0.0",
      startedAt: new Date().toISOString(),
    }));
    assert.equal(second.acquire(), true);
    assert.equal(firstLaunch.acquire(), true);
    assert.equal(secondLaunch.acquire(), false);
    firstLaunch.close();
    assert.equal(secondLaunch.acquire(), true);
  } finally {
    first.close();
    second.close();
    firstLaunch.close();
    secondLaunch.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("briefing preserves recovery rationale and structured closed outcomes", () => {
  const context = createContext();
  try {
    command(context.controller, "session", ["pwd", "C:/work"]);
    command(context.controller, "session", ["edit", {
      objective: "Ship", rationale: "User requested a trial", returnCondition: "All checks pass",
    }]);
    command(context.controller, "session", ["mkdir", "detour", {
      title: "Inspect hook", objective: "Find issue", rationale: "Resume was unsafe",
      openQuestions: ["Which receipt key?"], returnCondition: "Report fix",
    }]);
    command(context.controller, "session", ["cd", "detour"]);
    command(context.controller, "session", ["close", "done", "Receipt key corrected"]);

    const briefing = command(context.controller, "session", ["briefing"]);
    assert.equal(briefing.ancestry[0].work.rationale, "User requested a trial");
    assert.deepEqual(briefing.ancestry[0].closedChildOutcomes, [{
      path: "/detour",
      title: "Inspect hook",
      status: "done",
      summary: "Receipt key corrected",
    }]);
  } finally {
    context.cleanup();
  }
});

test("terminal state requires close and close validates descendants", () => {
  const context = createContext();
  try {
    command(context.controller, "session", ["pwd", "C:/work"]);
    command(context.controller, "session", ["mkdir", "child", { returnCondition: "finish" }]);
    assert.throws(
      () => command(context.controller, "session", ["edit", { status: "done" }]),
      /terminal status must be set with close/,
    );
    assert.throws(
      () => command(context.controller, "session", ["close", "done", "too early"]),
      /open descendants/,
    );
    const proposal = command(context.controller, "session", ["_submit-proposal", {
      kind: "compact", patch: { status: "done" },
    }]);
    assert.throws(
      () => command(context.controller, "session", ["decide-proposal", proposal.proposalId, "accept"]),
      /terminal status must be set with close/,
    );
  } finally {
    context.cleanup();
  }
});

test("proposal projections expose the affected work without unrelated current state", () => {
  const context = createContext();
  try {
    command(context.controller, "session", ["pwd", "C:/work"]);
    command(context.controller, "session", ["edit", { objective: "Base", rationale: "Why", returnCondition: "Finish" }]);
    const proposal = command(context.controller, "session", ["_submit-proposal", {
      kind: "compact", patch: { currentState: "Compact summary" },
    }]);
    assert.equal(proposal.targetPath, "/");
    assert.equal(proposal.afterPreview.currentState, "Compact summary");

    const decision = command(context.controller, "session", ["decide-proposal", proposal.proposalId, "accept"]);
    assert.equal(decision.before.currentState, "");
    assert.equal(decision.after.currentState, "Compact summary");
    assert.equal(decision.proposal.targetPath, "/");
  } finally {
    context.cleanup();
  }
});

test("search covers continuation fields and returns bounded field-aware matches", () => {
  const context = createContext();
  try {
    command(context.controller, "session", ["pwd", "C:/work"]);
    command(context.controller, "session", ["edit", {
      openQuestions: ["Which receipt is safe?"],
      returnCondition: "Find receipt policy",
      refs: [{ label: "design", value: "receipt timeline" }],
      metadata: { owner: "receipt-team" },
    }]);
    for (const [query, field] of [["safe", "openQuestions"], ["timeline", "refs"], ["team", "metadata"]]) {
      const result = command(context.controller, "session", ["search", query]);
      assert.ok(result.matches.some((match: { field: string; snippet: string }) => match.field === field && match.snippet.length <= 160));
    }
  } finally {
    context.cleanup();
  }
});

test("idempotent replay does not advance a second revision and validates workspace first", () => {
  const context = createContext();
  try {
    command(context.controller, "session", ["pwd", "C:/work"], "start-key");
    assert.throws(
      () => command(context.controller, "session", ["pwd", "C:/other"], "start-key"),
      /different workspace/,
    );
    command(context.controller, "session", ["edit", { currentState: "once" }], "edit-key");
    const first = command(context.controller, "session", ["rev-list"]);
    command(context.controller, "session", ["edit", { currentState: "once" }], "edit-key");
    const second = command(context.controller, "session", ["rev-list"]);
    assert.equal(second.head_revision, first.head_revision);
    assert.equal(second.revisions.length, first.revisions.length);
  } finally {
    context.cleanup();
  }
});

test("forks retain a frozen view after the parent changes", () => {
  const context = createContext();
  try {
    command(context.controller, "parent", ["pwd", "C:/work"]);
    command(context.controller, "parent", ["edit", { currentState: "before fork" }]);
    command(context.controller, "parent", ["fork", "child"]);
    command(context.controller, "parent", ["edit", { currentState: "after fork" }]);
    assert.equal(command(context.controller, "child", ["pwd"]).current_work.currentState, "before fork");
  } finally {
    context.cleanup();
  }
});

test("the daemon MCP endpoint and STDIO bridge expose the same command tool", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-tree-mcp-test-"));
  const port = 44_500 + (process.pid % 1_000);
  const daemon = fileURLToPath(new URL("../daemon.mjs", import.meta.url));
  const bridge = fileURLToPath(new URL("../mcp.mjs", import.meta.url));
  const environment = {
    ...process.env,
    CONTEXT_TREE_DATA_DIR: directory,
    CONTEXT_TREE_TEST_RUNTIME_DIR: join(directory, "runtime"),
    CONTEXT_TREE_MCP_PORT: String(port),
    CONTEXT_TREE_EPHEMERAL: "1",
  };
  const child = spawn(process.execPath, [daemon], { env: environment, stdio: "ignore" });
  let direct: Client | undefined;
  let proxy: Client | undefined;

  try {
    direct = await connectHttpClient(port);
    const directTools = await direct.listTools();
    assert.deepEqual(directTools.tools.map((tool) => tool.name), ["command"]);
    const directResult = await direct.callTool({
      name: "command",
      arguments: { sessionId: "direct", command: ["pwd", "C:/work"] },
    });
    assert.equal(directResult.isError, undefined);

    proxy = new Client({ name: "proxy-test", version: "1" });
    await proxy.connect(new StdioClientTransport({
      command: process.execPath,
      args: [bridge],
      env: environment,
      cwd: process.cwd(),
      stderr: "pipe",
    }));
    const proxyTools = await proxy.listTools();
    assert.deepEqual(proxyTools.tools.map((tool) => tool.name), ["command"]);
    const proxyResult = await proxy.callTool({
      name: "command",
      arguments: { sessionId: "proxy", command: ["pwd", "C:/work"] },
    });
    assert.equal(proxyResult.isError, undefined);
  } finally {
    await direct?.close();
    await proxy?.close();
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 150));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("PreCompact records a bounded transcript checkpoint when its worker is unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-tree-hook-test-"));
  const transcript = join(directory, "transcript.jsonl");
  writeFileSync(transcript, "x".repeat(50_000));
  try {
    const hook = fileURLToPath(new URL("../hook.mjs", import.meta.url));
    const event = JSON.stringify({
      hook_event_name: "PreCompact",
      session_id: "hook-session",
      transcript_path: transcript,
    });
    const result = spawnSync(process.execPath, [hook], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        CONTEXT_TREE_DATA_DIR: directory,
        CONTEXT_TREE_TEST_RUNTIME_DIR: join(directory, "runtime"),
        CONTEXT_TREE_CODEX_BIN: "context-tree-missing-worker",
        CONTEXT_TREE_EPHEMERAL: "1",
      },
      input: event,
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const journal = new DatabaseSync(join(directory, "journal", "hook-journal.sqlite"));
    const attempt = journal.prepare(
      "SELECT next_offset,truncated,diagnostic FROM compact_attempts_v2 WHERE session_id=?",
    ).get("hook-session") as { next_offset: number; truncated: number; diagnostic: string } | undefined;
    journal.close();
    assert.equal(attempt?.next_offset, 50_000);
    assert.equal(attempt?.truncated, 1);
    assert.match(attempt?.diagnostic ?? "", /worker|spawn|missing/i);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(directory, { recursive: true, force: true });
  }
});

async function connectHttpClient(port: number): Promise<Client> {
  const endpoint = new URL("http://127.0.0.1:" + port + "/mcp");
  let lastError: unknown;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const client = new Client({ name: "direct-test", version: "1" });

    try {
      await client.connect(new StreamableHTTPClientTransport(endpoint), { timeout: 250 });
      return client;
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("daemon MCP endpoint did not start");
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
