import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { renderAncestorBriefing, renderMinimalPath } from "./briefing.js";
import { callCommand, dataDir } from "./rpc.js";
import { BriefingResultSchema, JsonSchema, PwdStateSchema, WorkPatchSchema, type CommandAtom } from "./schema.js";

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
  writeOutput(renderMinimalPath(briefing) + "\n\n" + renderAncestorBriefing(briefing));
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
  const transcript = readTranscriptDelta(value.transcript_path);
  const candidate = summarizeCompact(state.current_work, transcript.delta);
  if (candidate.success) {
    await command(id, ["_submit-proposal", {
      kind: "compact",
      patch: JsonSchema.parse(candidate.data),
    }], 120_000, eventKey(value, "PreCompact"));
  }
  recordCompactAttempt(hookJournal, value, transcript.path, transcript.size, transcript.delta, candidate.success ? "" : "compact worker unavailable");
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

function summarizeCompact(current: unknown, delta: string) {
  const prompt = [
    "Return a conservative JSON patch for the current continuation node.",
    "Never create nodes, move a cursor, close work, or fork.",
    "CURRENT WORK:", JSON.stringify(current), "TRANSCRIPT DELTA:", delta,
  ].join("\n");
  const result = spawnSync(process.env.CONTEXT_TREE_CODEX_BIN ?? "codex", [
    "exec", "--ephemeral", "--disable", "hooks", "--sandbox", "read-only",
    "--output-schema", fileURLToPath(new URL("./compact-schema.json", import.meta.url)), "-",
  ], { input: prompt, encoding: "utf8", timeout: 120_000 });
  return WorkPatchSchema.safeParse(parseJson(result.stdout));
}

function readTranscriptDelta(transcriptPath: string | undefined): { path: string; size: number; delta: string } {
  if (!transcriptPath || !existsSync(transcriptPath)) return { path: transcriptPath ?? "", size: 0, delta: "" };
  const size = statSync(transcriptPath).size;
  return { path: transcriptPath, size, delta: readFileSync(transcriptPath).subarray(Math.max(0, size - 49_152)).toString() };
}

function openHookJournal(): HookJournal {
  const directory = join(dataDir(), "journal");
  mkdirSync(directory, { recursive: true });
  const output = new DatabaseSync(join(directory, "hook-journal.sqlite"));
  output.exec("CREATE TABLE IF NOT EXISTS hook_receipts_v1(key TEXT PRIMARY KEY, transcript_path TEXT, byte_offset INTEGER, fingerprint TEXT, diagnostic TEXT, created_at TEXT NOT NULL)");
  return output;
}

function recordCompactAttempt(journal: HookJournal, value: HookEvent, path: string, offset: number, delta: string, diagnostic: string): void {
  journal.prepare("INSERT OR REPLACE INTO hook_receipts_v1 VALUES(?,?,?,?,?,?)").run(eventKey(value, "PreCompact"), path, offset, createHash("sha256").update(delta).digest("hex"), diagnostic, new Date().toISOString());
}

function sessionId(value: HookEvent): string { return value.session_id ?? ""; }
function subagentSessionId(value: HookEvent): string { return value.agent_id ? sessionId(value) + ":agent:" + value.agent_id : sessionId(value); }
function eventKey(value: HookEvent, kind: string): string { return createHash("sha256").update([kind, subagentSessionId(value), value.transcript_path ?? "", value.last_assistant_message ?? ""].join("|")).digest("hex"); }

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
