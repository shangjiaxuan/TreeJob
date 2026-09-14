import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { renderAncestorBriefing, renderMinimalPath } from "./briefing.js";
import { callCommand, dataDir } from "./rpc.js";
import {
  BriefingResultSchema,
  JsonSchema,
  ProposalListResultSchema,
  PwdStateSchema,
  WorkPatchSchema,
  type CommandAtom,
} from "./schema.js";

const HookEventSchema = z.object({
  hook_event_name: z.string().optional(),
  session_id: z.string().optional(),
  agent_id: z.string().optional(),
  cwd: z.string().optional(),
  source: z.string().optional(),
  transcript_path: z.string().optional(),
  last_assistant_message: z.string().optional(),
}).passthrough();

type HookEvent = z.infer<typeof HookEventSchema>;
type HookJournal = DatabaseSync;
type TranscriptDelta = {
  path: string;
  size: number;
  previousOffset: number;
  nextOffset: number;
  prefixFingerprint: string;
  delta: string;
  truncated: boolean;
  diagnostic: string;
};

const event = HookEventSchema.parse(await readStdinJson());
const journal = openHookJournal();

try {
  await handleEvent(event, journal);
} catch (error) {
  writeOutput(undefined, "Context Tree hook degraded: " + message(error));
}

async function handleEvent(value: HookEvent, hookJournal: HookJournal): Promise<void> {
  switch (value.hook_event_name) {
    case "SessionStart": return sessionStart(value);
    case "SubagentStart": return subagentStart(value);
    case "SubagentStop": return subagentStop(value);
    case "PreCompact": return preCompact(value, hookJournal);
    case "Stop": return stop(value);
    default: return;
  }
}

async function sessionStart(value: HookEvent): Promise<void> {
  const id = sessionId(value);
  await command(id, ["pwd", value.cwd ?? process.cwd()], 8_000, eventKey(value, "SessionStart"));
  const briefing = BriefingResultSchema.parse(await command(id, ["briefing"]));
  const compactDecision = value.source === "compact"
    ? ProposalListResultSchema.parse(await command(id, ["proposals"]))
      .proposals.find((proposal) => proposal.kind === "compact")
    : undefined;
  const decisionContext = compactDecision
    ? "\n\nPENDING COMPACT PROPOSAL\n" + JSON.stringify(compactDecision, null, 2)
    : "";
  writeOutput(renderMinimalPath(briefing) + "\n\n" + renderAncestorBriefing(briefing) + decisionContext);
}

async function subagentStart(value: HookEvent): Promise<void> {
  const parent = sessionId(value);
  const child = subagentSessionId(value);
  await command(parent, ["fork", child], 8_000, eventKey(value, "SubagentStart"));
  const briefing = BriefingResultSchema.parse(await command(child, ["briefing"]));
  writeOutput(renderMinimalPath(briefing) + "\n\n" + renderAncestorBriefing(briefing));
}

async function subagentStop(value: HookEvent): Promise<void> {
  await command(sessionId(value), ["_submit-proposal", {
    kind: "subagent_result",
    sourceSessionId: subagentSessionId(value),
    patch: { currentState: value.last_assistant_message ?? "Subagent completed; inspect its frozen branch." },
  }], 8_000, eventKey(value, "SubagentStop"));
  writeOutput(undefined, "Context Tree saved a subagent proposal.");
}

async function preCompact(value: HookEvent, hookJournal: HookJournal): Promise<void> {
  const id = sessionId(value);
  const state = PwdStateSchema.parse(await command(id, ["pwd"]));
  const briefing = BriefingResultSchema.parse(await command(id, ["briefing"]));
  const transcript = readTranscriptDelta(hookJournal, id, value.transcript_path);
  let diagnostic = transcript.diagnostic;
  try {
    const candidate = summarizeCompact(state.current_work, briefing, transcript.delta);
    if (!candidate.success) {
      diagnostic = candidate.diagnostic;
      return;
    }
    await command(id, ["_submit-proposal", {
      kind: "compact",
      patch: JsonSchema.parse(candidate.data),
    }], 120_000, eventKey(value, "PreCompact"));
  } catch (error) {
    diagnostic = message(error);
  } finally {
    recordCompactAttempt(hookJournal, value, transcript, diagnostic);
  }
}

async function stop(value: HookEvent): Promise<void> {
  const briefing = BriefingResultSchema.parse(await command(sessionId(value), ["briefing"]));
  if (briefing.unresolvedCount > 0) {
    writeOutput(undefined, "Context Tree: " + briefing.unresolvedCount + " node(s) remain open or blocked.");
  }
}

function command(
  sessionId: string,
  command_: readonly CommandAtom[],
  timeout = 8_000,
  idempotencyKey?: string,
): Promise<unknown> {
  return callCommand({ sessionId, command: [...command_] }, timeout, idempotencyKey);
}

function summarizeCompact(current: unknown, briefing: unknown, delta: string): { success: true; data: unknown; diagnostic: string } | { success: false; diagnostic: string } {
  const prompt = [
    "Return a conservative JSON patch for the current continuation node.",
    "Never create nodes, move a cursor, close work, or fork.",
    "CURRENT WORK:", JSON.stringify(current), "IMMUTABLE CONTEXT LOOKBACK:", JSON.stringify(briefing), "TRANSCRIPT DELTA:", delta,
  ].join("\n");
  const result = spawnSync(process.env.CONTEXT_TREE_CODEX_BIN ?? "codex", [
    "exec", "--ephemeral", "--disable", "hooks", "--sandbox", "read-only",
    "--output-schema", fileURLToPath(new URL("./compact-schema.json", import.meta.url)), "-",
  ], { input: prompt, encoding: "utf8", timeout: 120_000 });
  const parsed = WorkPatchSchema.safeParse(parseJson(result.stdout));
  return parsed.success
    ? { success: true, data: parsed.data, diagnostic: "" }
    : { success: false, diagnostic: result.error?.message || "compact worker returned invalid JSON" };
}

function readTranscriptDelta(journal: HookJournal, session: string, transcriptPath: string | undefined): TranscriptDelta {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return {
      path: transcriptPath ?? "", size: 0, previousOffset: 0, nextOffset: 0,
      prefixFingerprint: "", delta: "", truncated: false, diagnostic: "transcript unavailable",
    };
  }
  const path = resolve(transcriptPath);
  const content = readFileSync(path);
  const size = statSync(path).size;
  const prefixFingerprint = createHash("sha256").update(content.subarray(0, 4096)).digest("hex");
  const checkpoint = journal.prepare(
    "SELECT byte_offset,prefix_fingerprint FROM transcript_checkpoints_v2 WHERE session_id=? AND transcript_path=?",
  ).get(session, path) as { byte_offset?: number; prefix_fingerprint?: string } | undefined;
  const checkpointOffset = checkpoint?.byte_offset ?? 0;
  const valid = checkpoint !== undefined
    && checkpointOffset <= size
    && checkpoint.prefix_fingerprint === prefixFingerprint;
  const previousOffset = valid ? checkpointOffset : 0;
  const start = Math.max(previousOffset, size - 49_152);
  return {
    path,
    size,
    previousOffset,
    nextOffset: size,
    prefixFingerprint,
    delta: content.subarray(start).toString(),
    truncated: start > previousOffset,
    diagnostic: valid || checkpoint === undefined ? "" : "transcript offset reset after rotation or fingerprint mismatch",
  };
}

function openHookJournal(): HookJournal {
  const directory = join(dataDir(), "journal");
  mkdirSync(directory, { recursive: true });
  const output = new DatabaseSync(join(directory, "hook-journal.sqlite"));
  output.exec("CREATE TABLE IF NOT EXISTS transcript_checkpoints_v2(session_id TEXT NOT NULL,transcript_path TEXT NOT NULL,byte_offset INTEGER NOT NULL,prefix_fingerprint TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(session_id,transcript_path))");
  output.exec("CREATE TABLE IF NOT EXISTS compact_attempts_v2(key TEXT PRIMARY KEY,session_id TEXT NOT NULL,transcript_path TEXT NOT NULL,previous_offset INTEGER NOT NULL,next_offset INTEGER NOT NULL,prefix_fingerprint TEXT NOT NULL,truncated INTEGER NOT NULL,diagnostic TEXT NOT NULL,created_at TEXT NOT NULL)");
  return output;
}

function recordCompactAttempt(journal: HookJournal, value: HookEvent, transcript: TranscriptDelta, diagnostic: string): void {
  const now = new Date().toISOString();
  journal.exec("BEGIN IMMEDIATE");
  try {
    if (transcript.path) {
      journal.prepare("INSERT OR REPLACE INTO transcript_checkpoints_v2 VALUES(?,?,?,?,?)")
        .run(sessionId(value), transcript.path, transcript.nextOffset, transcript.prefixFingerprint, now);
    }
    journal.prepare("INSERT OR REPLACE INTO compact_attempts_v2 VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        eventKey(value, "PreCompact"), sessionId(value), transcript.path, transcript.previousOffset,
        transcript.nextOffset, transcript.prefixFingerprint, transcript.truncated ? 1 : 0, diagnostic, now,
      );
    journal.exec("COMMIT");
  } catch (error) {
    journal.exec("ROLLBACK");
    throw error;
  }
}

function sessionId(value: HookEvent): string { return value.session_id ?? ""; }
function subagentSessionId(value: HookEvent): string { return value.agent_id ? sessionId(value) + ":agent:" + value.agent_id : sessionId(value); }
function eventKey(value: HookEvent, kind: string): string {
  const workspace = kind === "SessionStart" ? resolve(value.cwd ?? process.cwd()) : "";
  return createHash("sha256")
    .update([kind, subagentSessionId(value), workspace, value.source ?? "", value.transcript_path ?? "", value.last_assistant_message ?? ""].join("|"))
    .digest("hex");
}

function writeOutput(context?: string, systemMessage?: string): void {
  console.log(JSON.stringify({
    ...(systemMessage ? { systemMessage } : {}),
    ...(context ? { hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: context } } : {}),
  }));
}

async function readStdinJson(): Promise<unknown> {
  const text = await new Promise<string>((resolve) => {
    let value = "";
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", () => resolve(value));
  });
  return parseJson(text) ?? {};
}

function parseJson(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
