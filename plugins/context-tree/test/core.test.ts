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
import { renderBrowsePage } from "../src/clients/browser/browse-view.js";
import type { BrowserView } from "../src/clients/browser/browse-data.js";

type Context = {
  controller: ContinuationController;
  repository: SqliteRecordRepository;
  directory: string;
  cleanup(): void;
};

function createContext(): Context {
  const directory = mkdtempSync(join(tmpdir(), "context-tree-test-"));
  const repository = new SqliteRecordRepository(join(directory, "context-tree.sqlite"));
  return {
    controller: new ContinuationController(repository),
    repository,
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

test("ls briefing stays direct while cd returns the full active ancestry", () => {
  const context = createContext();
  try {
    command(context.controller, "session", ["pwd", "C:/work"]);
    command(context.controller, "session", ["mkdir", "child", { objective: "Child", returnCondition: "finish" }]);
    const listed = command(context.controller, "session", ["ls", "-a"]);
    assert.equal(listed.childBriefings.length, 1);
    assert.equal(listed.childBriefings[0].path, "/child");
    const moved = command(context.controller, "session", ["cd", "child"]);
    assert.deepEqual(moved.briefing.map((entry: { path: string }) => entry.path), ["/", "/child"]);
  } finally {
    context.cleanup();
  }
});

test("published references own revisions while events remain diagnostic", () => {
  const context = createContext();
  let database: DatabaseSync | undefined;

  try {
    command(context.controller, "session", ["pwd", "C:/work"]);
    command(context.controller, "session", ["edit", { currentState: "recorded" }]);
    const head = context.repository.getHeadSessionView("session");
    database = new DatabaseSync(join(context.directory, "context-tree.sqlite"));
    const revisions = database.prepare(
      "SELECT revision FROM branch_revisions_v9 WHERE branch_id=? ORDER BY revision",
    ).all(head.session.branchId) as Array<{ revision: number }>;
    const reference = database.prepare(
      "SELECT record_id FROM published_node_refs_v9 WHERE branch_id=? AND inode_id=? AND revision=?",
    ).get(head.session.branchId, head.view.rootNodeId, 1) as { record_id: number } | undefined;
    const event = database.prepare(
      "SELECT revision,event_json FROM session_events_v9 WHERE session_id=? AND revision=?",
    ).get("session", 1) as { revision: number; event_json: string } | undefined;
    const plan = database.prepare(
      "EXPLAIN QUERY PLAN SELECT record_id FROM published_node_refs_v9 WHERE branch_id=? AND inode_id=? AND revision>=? AND revision<=? ORDER BY revision DESC LIMIT 1",
    ).all(head.session.branchId, head.view.rootNodeId, 0, 1) as Array<{ detail: string }>;
    assert.deepEqual(revisions.map((row) => row.revision), [0, 1]);
    assert.equal(typeof reference?.record_id, "number");
    assert.equal(event?.revision, 1);
    assert.equal(JSON.parse(event?.event_json ?? "{}").action, "edit");
    assert.ok(plan.every((row) => row.detail.includes("SEARCH") && !row.detail.includes("SCAN") && !row.detail.includes("JOIN")));
  } finally {
    database?.close();
    context.cleanup();
  }
});

test("payload edits and topology edits publish independent record streams", () => {
  const context = createContext();
  let database: DatabaseSync | undefined;

  try {
    command(context.controller, "session", ["pwd", "C:/work"]);
    command(context.controller, "session", ["mkdir", "child", { returnCondition: "finish" }]);
    command(context.controller, "session", ["cd", "child"]);
    command(context.controller, "session", ["edit", { currentState: "changed" }]);

    const root = context.repository.getSessionRevision("session", 0);
    const child = context.repository.getSessionRevision("session", 2);
    const rootRecord = context.repository.resolveNodeRecord(root.rootNodeId, root);
    const [entry] = context.repository.listEffectiveLinks(root.rootNodeId, child);
    assert.ok(entry);
    const childNode = command(context.controller, "session", ["pwd"]);
    const childRecord = context.repository.resolveNodeRecord(
      entry.childNodeId,
      child,
    );

    assert.equal(rootRecord.id, context.repository.resolveNodeRecord(root.rootNodeId, child).id);
    assert.equal(childRecord.attributes.currentState, "changed");
    assert.equal(childNode.current_work.currentState, "changed");

    database = new DatabaseSync(join(context.directory, "context-tree.sqlite"));
    const nodeColumns = database.prepare("PRAGMA table_info(node_records_v9)").all() as Array<{ name: string }>;
    const plans = [
      database.prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM branch_spans_v9 WHERE branch_id=? AND first_revision<=? ORDER BY first_revision DESC LIMIT 1",
      ).all(context.repository.getSession("session").branchId, 2),
      database.prepare(
        "EXPLAIN QUERY PLAN SELECT link_id,record_id,revision FROM published_link_refs_v9 WHERE branch_id=? AND parent_inode_id=? AND revision>=? AND revision<=? ORDER BY revision DESC",
      ).all(context.repository.getSession("session").branchId, root.rootNodeId, 0, 2),
    ] as Array<Array<{ detail: string }>>;

    assert.ok(!nodeColumns.some((column) => column.name === "work_json"));
    assert.ok(plans.flat().every((row) => row.detail.includes("SEARCH") && !row.detail.includes("SCAN") && !row.detail.includes("JOIN")));
  } finally {
    database?.close();
    context.cleanup();
  }
});

test("moved links suppress their former parent without rewriting node work", () => {
  const context = createContext();

  try {
    command(context.controller, "session", ["pwd", "C:/work"]);
    command(context.controller, "session", ["mkdir", "source", { returnCondition: "finish" }]);
    command(context.controller, "session", ["mkdir", "destination", { returnCondition: "finish" }]);
    command(context.controller, "session", ["mv", "/source", "/destination/source"]);

    const root = command(context.controller, "session", ["ls", "/"]);
    const destination = command(context.controller, "session", ["ls", "/destination"]);

    assert.deepEqual(root.entries.map((entry: { name: string }) => entry.name), ["destination"]);
    assert.deepEqual(destination.entries.map((entry: { name: string }) => entry.name), ["source"]);
  } finally {
    context.cleanup();
  }
});

test("verbose revision and link queries expose their concrete creating views", () => {
  const context = createContext();

  try {
    command(context.controller, "session", ["pwd", "C:/work"]);
    command(context.controller, "session", ["mkdir", "test", { returnCondition: "finish" }]);
    command(context.controller, "session", ["mv", "/test", "/renamed"]);

    const concise = command(context.controller, "session", ["rev-list", "renamed"]);
    const verbose = command(context.controller, "session", ["rev-list", "renamed", "--verbose"]);
    const links = command(context.controller, "session", [
      "query-link",
      "parent",
      "renamed",
      "--revision",
      "2",
      "--reference",
      "2",
    ]);

    assert.ok(concise.revisions.every((revision: { created_view?: unknown }) => revision.created_view === undefined));
    assert.deepEqual(
      verbose.revisions.map((revision: { revision: number; created_view?: { sessionId: string; revision: number } }) => ({
        revision: revision.revision,
        createdView: revision.created_view,
      })),
      [
        { revision: 1, createdView: { sessionId: "1", revision: 1 } },
        { revision: 2, createdView: { sessionId: "1", revision: 1 } },
      ],
    );
    assert.deepEqual(links.links, [{
      name: "renamed",
      revisions: [
        { created_view: { sessionId: "1", revision: 1 }, name: "test", createdAt: links.links[0].revisions[0].createdAt },
        { created_view: { sessionId: "1", revision: 2 }, name: "renamed", createdAt: links.links[0].revisions[1].createdAt },
      ],
    }]);
  } finally {
    context.cleanup();
  }
});

test("browser links retain explicit session query semantics without cookies", () => {
  const view: BrowserView = {
    sessionId: "browser-session",
    currentPath: "/",
    referencePath: "/",
    headRevision: 3,
    hasExplicitView: false,
    selectedRevision: { revision: 3, createdAt: "2026-09-15T00:00:00.000Z", changes: [] },
    referenceRevision: 3,
    work: {
      kind: "node", title: "", objective: "", rationale: "", currentState: "", openQuestions: [],
      returnCondition: "", refs: [], metadata: {}, status: "open",
    },
    entries: [],
    nodeRevisions: [],
    tree: { name: "/", path: "/", title: "", status: "open", children: [] },
  };
  const page = renderBrowsePage(view);

  assert.match(page, /\/browse\/\?sessionId=browser-session/);
  assert.doesNotMatch(page, /logout|Set-Cookie/);
  assert.match(page, /max=\"3\"/);
});

test("rev-show without a revision reads a path from the lightweight session head", () => {
  const context = createContext();

  try {
    command(context.controller, "session", ["pwd", "C:/work"]);
    command(context.controller, "session", ["mkdir", "child", {
      currentState: "current work",
      returnCondition: "finish",
    }]);
    const shown = command(context.controller, "session", ["rev-show", "/child"]);

    assert.equal(shown.details.revision.revision, 1);
    assert.equal(shown.details.view_path, "/child");
    assert.equal(shown.details.work.currentState, "current work");
  } finally {
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
    writeFileSync(join(runtime, "daemon-v9.json"), JSON.stringify({
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

test("sessions share mainline state while private overlays remain local", () => {
  const context = createContext();
  try {
    command(context.controller, "parent", ["pwd", "C:/work"]);
    command(context.controller, "parent", ["edit", { currentState: "shared" }]);
    command(context.controller, "child", ["pwd", "C:/work"]);
    assert.equal(command(context.controller, "child", ["pwd"]).current_work.currentState, "shared");
    command(context.controller, "child", ["edit", { currentState: "draft" }]);
    assert.equal(command(context.controller, "child", ["pwd"]).current_work.currentState, "draft");
    assert.equal(command(context.controller, "parent", ["pwd"]).current_work.currentState, "shared");
  } finally {
    context.cleanup();
  }
});

test("published overlays become owner mailbox candidates and accept atomically updates main", () => {
  const context = createContext();
  try {
    command(context.controller, "owner-session", ["set-identity", "owner"]);
    command(context.controller, "owner-session", ["pwd", "C:/work"]);
    command(context.controller, "owner-session", ["edit", { currentState: "authoritative" }]);
    command(context.controller, "author-session", ["set-identity", "author"]);
    command(context.controller, "author-session", ["pwd", "C:/work"]);
    command(context.controller, "author-session", ["edit", { currentState: "candidate" }]);
    command(context.controller, "author-session", ["publish"]);

    const inbox = command(context.controller, "owner-session", ["proposals", "--scope=inbox"]);
    assert.equal(inbox.mailbox.length, 1);
    assert.equal(inbox.mailbox[0].candidateWork.currentState, "candidate");
    const accepted = command(context.controller, "owner-session", [
      "decide-proposal", "mailbox", ".", "author-session", "accept",
    ]);
    assert.equal(accepted.status, "applied");
    assert.equal(command(context.controller, "owner-session", ["pwd"]).current_work.currentState, "candidate");
    assert.equal(command(context.controller, "author-session", ["pwd"]).current_work.currentState, "candidate");
  } finally {
    context.cleanup();
  }
});

test("a group topology dropbox permits shared child creation without granting child content ownership", () => {
  const context = createContext();
  try {
    command(context.controller, "owner-session", ["set-identity", "owner", ["team"]]);
    command(context.controller, "owner-session", ["pwd", "C:/work"]);
    command(context.controller, "owner-session", ["chmod", "744", "776", ".", "--group", "team"]);
    command(context.controller, "member-session", ["set-identity", "member", ["team"]]);
    command(context.controller, "member-session", ["pwd", "C:/work"]);
    command(context.controller, "member-session", ["mkdir", "drop", { returnCondition: "finish" }]);
    command(context.controller, "owner-session", ["cd", "drop"]);
    command(context.controller, "owner-session", ["edit", { currentState: "owner draft" }]);
    assert.equal(command(context.controller, "member-session", ["cd", "drop"]).briefing.at(-1)?.work.currentState, "");
    assert.equal(command(context.controller, "owner-session", ["pwd"]).current_work.currentState, "owner draft");
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
