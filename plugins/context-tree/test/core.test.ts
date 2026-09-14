import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ContinuationController } from "../src/daemon-service.js";
import { SqliteRecordRepository } from "../src/record-repository.js";

type Context = {
  controller: ContinuationController;
  cleanup(): void;
};

function createContext(): Context {
  const directory = mkdtempSync(join(tmpdir(), "context-tree-test-"));
  const repository = new SqliteRecordRepository(join(directory, "context-tree.sqlite"));
  return {
    controller: new ContinuationController(repository),
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
