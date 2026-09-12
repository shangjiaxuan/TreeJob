import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  renderAncestorBriefing,
  renderMinimalPath,
} from "./briefing.js";
import { call, dataDir } from "./rpc.js";
import {
  PayloadPatchSchema,
  type PayloadFields,
} from "./schema.js";

const HookEventSchema = z.object({
  hook_event_name: z.string().optional(),
  session_id: z.string().optional(),
  agent_id: z.string().optional(),
  cwd: z.string().optional(),
  source: z.string().optional(),
  transcript_path: z.string().optional(),
  model: z.string().optional(),
  last_assistant_message: z.string().optional(),
}).passthrough();

type HookEvent = z.infer<typeof HookEventSchema>;
type HookJournal = DatabaseSync;

const event = HookEventSchema.parse(await readStdinJson());
const journal = openHookJournal();

try {
  await handleEvent(event, journal);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeOutput(undefined, "Context Tree hook degraded: " + message);
}

async function handleEvent(event: HookEvent, journal: HookJournal): Promise<void> {
  switch (event.hook_event_name) {
    case "SessionStart":
      await handleSessionStart(event);
      return;
    case "SubagentStart":
      await handleSubagentStart(event);
      return;
    case "SubagentStop":
      await handleSubagentStop(event);
      return;
    case "PreCompact":
      await handlePreCompact(event, journal);
      return;
    case "Stop":
      await handleStop(event);
      return;
    default:
      return;
  }
}

async function handleSessionStart(event: HookEvent): Promise<void> {
  const context = await call("registerSession", {
    sessionId: sessionId(event),
    cwd: event.cwd ?? process.cwd(),
    commandId: eventKey(event, "SessionStart"),
  });

  writeOutput(contextRestoreBrief(context));
}

async function handleSubagentStart(event: HookEvent): Promise<void> {
  const parentSessionId = sessionId(event);
  const context = await call("forkSession", {
    sessionId: subagentSessionId(event),
    parentSessionId,
    commandId: eventKey(event, "SubagentStart"),
  });

  writeOutput(contextRestoreBrief(context));
}

async function handleSubagentStop(event: HookEvent): Promise<void> {
  const parentSessionId = sessionId(event);

  await call("createProposal", {
    sessionId: parentSessionId,
    kind: "subagent_result",
    patch: {
      currentState: event.last_assistant_message ??
        "Subagent completed; inspect its branch.",
    },
    sourceSessionId: subagentSessionId(event),
    commandId: eventKey(event, "SubagentStop"),
  });

  writeOutput(
    undefined,
    "Context Tree saved an idempotent subagent proposal.",
  );
}

async function handlePreCompact(
  event: HookEvent,
  journal: HookJournal,
): Promise<void> {
  const currentSessionId = sessionId(event);
  const context = await call("getContext", { sessionId: currentSessionId });
  const transcript = readTranscriptDelta(event.transcript_path);
  const candidate = summarizeCompact(context.current, transcript.delta);

  if (candidate.success) {
    await call("createProposal", {
      sessionId: currentSessionId,
      kind: "compact",
      patch: candidate.data,
      commandId: eventKey(event, "PreCompact"),
    });
  }

  recordCompactAttempt(
    journal,
    event,
    transcript.path,
    transcript.size,
    transcript.delta,
    candidate.success ? "" : "compact worker unavailable",
  );
}

async function handleStop(event: HookEvent): Promise<void> {
  const context = await call("getContext", { sessionId: sessionId(event) });

  if (context.unresolved.length > 0) {
    writeOutput(
      undefined,
      "Context Tree: " + context.unresolved.length +
        " record(s) remain open or blocked.",
    );
  }
}

function summarizeCompact(
  current: PayloadFields,
  delta: string,
) {
  const prompt = [
    "Return a conservative JSON scalar update for the current continuation record.",
    "Never create nodes, move a cursor, close work, or fork.",
    "CONTEXT:",
    JSON.stringify(current),
    "DELTA:",
    delta,
  ].join("\n");
  const result = spawnSync(
    process.env.CONTEXT_TREE_CODEX_BIN ?? "codex",
    [
      "exec",
      "--ephemeral",
      "--disable",
      "hooks",
      "--sandbox",
      "read-only",
      "--output-schema",
      fileURLToPath(new URL("./compact-schema.json", import.meta.url)),
      "-",
    ],
    {
      input: prompt,
      encoding: "utf8",
      timeout: 120_000,
    },
  );

  return PayloadPatchSchema.safeParse(parseJson(result.stdout));
}

function readTranscriptDelta(transcriptPath: string | undefined): {
  path: string;
  size: number;
  delta: string;
} {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return {
      path: transcriptPath ?? "",
      size: 0,
      delta: "",
    };
  }

  const size = statSync(transcriptPath).size;
  const start = Math.max(0, size - 49_152);
  const delta = readFileSync(transcriptPath)
    .subarray(start)
    .toString();

  return {
    path: transcriptPath,
    size,
    delta,
  };
}

function openHookJournal(): HookJournal {
  const directory = join(dataDir(), "journal");
  mkdirSync(directory, { recursive: true });

  const journal = new DatabaseSync(join(directory, "hook-journal.sqlite"));
  journal.exec(
    "CREATE TABLE IF NOT EXISTS hook_receipts_v1(" +
      "key TEXT PRIMARY KEY, " +
      "transcript_path TEXT, " +
      "byte_offset INTEGER, " +
      "fingerprint TEXT, " +
      "diagnostic TEXT, " +
      "created_at TEXT NOT NULL" +
      ")",
  );

  return journal;
}

function recordCompactAttempt(
  journal: HookJournal,
  event: HookEvent,
  transcriptPath: string,
  byteOffset: number,
  delta: string,
  diagnostic: string,
): void {
  journal.prepare(
    "INSERT OR REPLACE INTO hook_receipts_v1 VALUES(?,?,?,?,?,?)",
  ).run(
    eventKey(event, "PreCompact"),
    transcriptPath,
    byteOffset,
    createHash("sha256").update(delta).digest("hex"),
    diagnostic,
    new Date().toISOString(),
  );
}

function sessionId(event: HookEvent): string {
  return event.session_id ?? "";
}

function subagentSessionId(event: HookEvent): string {
  const parent = sessionId(event);
  return event.agent_id ? parent + ":agent:" + event.agent_id : parent;
}

function eventKey(event: HookEvent, kind: string): string {
  return createHash("sha256").update([
    kind,
    subagentSessionId(event),
    event.transcript_path ?? "",
    event.last_assistant_message ?? "",
  ].join("|")).digest("hex");
}

function contextRestoreBrief(
  context: Awaited<ReturnType<typeof call<"getContext">>>,
): string {
  return [
    renderMinimalPath(context),
    renderAncestorBriefing(context),
  ].join("\n\n");
}

function writeOutput(context?: string, systemMessage?: string): void {
  const output = {
    ...(systemMessage ? { systemMessage } : {}),
    ...(context
      ? {
        hookSpecificOutput: {
          hookEventName: event.hook_event_name,
          additionalContext: context,
        },
      }
      : {}),
  };

  console.log(JSON.stringify(output));
}

async function readStdinJson(): Promise<unknown> {
  const text = await new Promise<string>((resolve) => {
    let value = "";

    process.stdin.on("data", (chunk) => {
      value += chunk;
    });
    process.stdin.on("end", () => {
      resolve(value);
    });
  });

  return parseJson(text) ?? {};
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
