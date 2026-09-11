# Context Tree PoC — Daemon-Managed Continuation State

## Summary

Build `context-tree` as a TypeScript Codex plugin installed through this repository’s project marketplace. A local on-demand daemon is the sole owner of continuation-tree SQLite state; the STDIO MCP server and lifecycle hooks are clients of that daemon.

The system separates durable execution state from transcript bookkeeping:

```text
Context daemon
  owns: records, COW versions, cursors, events, proposals, search

Hook journal
  owns: transcript offsets, worker attempts, transcript fingerprints

codex exec summarizer
  reads: daemon lookback + journal transcript delta
  writes: JSON proposal only
```

The daemon starts on demand, is shared by all local Codex sessions, and exits after a short idle period. No persistent login service is installed.

## State and Daemon Design

- Implement strict ESM TypeScript on Node 22+ with the MCP SDK, `node:sqlite`, Zod, and Node’s built-in test runner. Bundle production JavaScript so installed plugin runtime does not depend on `node_modules`.
- Place the plugin in `plugins/context-tree` and register it through `.agents/plugins/marketplace.json`.
- Default global data location to `%LOCALAPPDATA%\ContextTree` on Windows, with `CONTEXT_TREE_DATA_DIR` override. Workspace identity is the canonical session `cwd`.
- Run a daemon over a user-local socket: named pipe on Windows and Unix socket elsewhere. A startup lock plus endpoint/PID registry prevents races and detects stale daemons.
- Treat session ID as routing identity, not security authentication. The daemon listens only locally; v1 assumes the same OS user is trusted.
- The daemon owns one SQLite database and exclusively performs all continuation-tree reads and writes:
  - sessions: workspace, parent session, fork cursor, source, lifecycle;
  - logical records and session-local record versions;
  - session cursors;
  - append-only events and checkpoints;
  - pending compact and subagent-result proposals.
- Record versions use COW resolution: read the newest local revision first, then walk parent-session lineage. Updating inherited data creates a local revision; adding a child never edits its inherited parent.
- A record has free-form `kind`, title, objective, rationale, current state, open questions, return condition, references, metadata, and status: `open`, `blocked`, `done`, `abandoned`, or `superseded`.
- `active` is derived from the unique session cursor, never stored on records. A record can become terminal only when all reachable descendants are terminal.

## MCP and Agent Contract

- The plugin MCP launcher starts or connects to the daemon, then serves STDIO MCP as a thin typed adapter. It contains no SQLite access.
- Every MCP call requires explicit `sessionId`; root sessions use Codex’s session ID and subagents use a deterministic parent-session-plus-agent identity.
- Expose:
  - `get_context`, `search_context`, and `list_proposals`;
  - `push_child`, `add_sibling`, `enter`, `back`, `update_record`, and `close_record`;
  - `decide_proposal`;
  - `fork_session` for explicit binding of a new/clean session to a known parent and fork cursor.
- `push_child` and `add_sibling` require a return condition. The bundled skill directs agents to create a node only for independently returnable work, not individual mechanical steps.
- `close_record` requires terminal status and a summary, and returns to the parent by default. Root completion means the root and every reachable node are terminal.
- `search_context` defaults to the active ancestry; callers may expand to session tree, workspace, or global database scope. References are stored on records, but filesystem `rg` execution is deferred.
- Provide a bundled skill and copyable AGENTS.md snippet: inspect active context before broad searches; preserve return conditions; explicitly close or abandon detours; decide a compact proposal before further tree mutation.
- The Stop hook is advisory: it asks the daemon for unresolved records and emits a warning, but never forces another agent turn.

## Hooks, Compaction, and Branching

- Hooks never open the continuation SQLite database. Each hook uses a daemon RPC client that starts/connects to the daemon, sends its session identity, and calls a typed management operation.
- Keep a separate hook-journal SQLite file for transcript cursor/offset, transcript fingerprint, worker invocation state, and failure diagnostics. It cannot contain record state or mutate the context tree.
- `SessionStart` registers/restores the session through the daemon. New unbound chats receive a placeholder root; resumed sessions restore their cursor and active path.
- `SubagentStart` receives parent session and agent ID, so it automatically creates a COW child session at the parent cursor and injects that branch’s active path. `SubagentStop` submits a parent-visible proposal pointing at the child branch.
- Parent handling of a subagent proposal is explicit: accept provenance, summarize into the parent’s current record, or discard. V1 does not structurally merge child records.
- Independent chats default to new roots. Do not infer parentage from recency. Preserve session IDs and proposal provenance so a later version can add cross-session references, user identity recognition, and configurable automatic fork association.
- `PreCompact`:
  1. asks the daemon for immutable active-path/current-record lookback and base revision;
  2. reads only the unsummarized transcript delta through the hook journal;
  3. launches `codex exec` with the same model, `--ephemeral`, `--disable hooks`, read-only sandbox, fixed JSON schema, and fixed summary prompt;
  4. submits the validated result as a pending proposal to the daemon;
  5. updates only hook-journal checkpoint data.
- Cap source transcript input at 48 KiB and worker time at 120 seconds. On CLI, transcript, schema, or daemon failure, save journal diagnostics and permit compact with structural state only.
- The summarizer may propose scalar updates and an append-only summary event; it cannot reshape the tree, move the cursor, close records, or fork sessions.
- `SessionStart(source=compact)` fetches and injects the active ancestry, before-state, proposed patch, after-preview, and a required apply/revise/reject decision. This hook is the supported immediate continuation injection point after compaction. [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- `decide_proposal` validates its base revision before applying. A stale proposal must be revised or rejected; it cannot overwrite newer state.

## Validation and Acceptance

- Unit-test daemon COW resolution, session lineage, cursor navigation, sibling ordering, terminal invariants, scoped search, and explicit session binding.
- Test proposal creation, before/after rendering, apply, revise, reject, and stale-revision conflict.
- Test daemon launch races, stale endpoint recovery, idle shutdown, and concurrent local clients.
- Test MCP STDIO integration against the daemon using temporary user-data directories.
- Test hook fixtures for root start/resume, compact restore, subagent start/stop, unavailable daemon, summarizer timeout, malformed worker output, and transcript-offset mismatch.
- Test the worker command builder with a fake executable; no automated test spends Codex usage.
- Build and validate the plugin, verify its project-marketplace entry, then manually exercise: root task → detour → compact proposal → explicit decision → subagent COW branch → parent result decision.
