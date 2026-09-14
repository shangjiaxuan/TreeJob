# Context Tree daily-trial checklist

Status: proposed implementation target, 2026-09-14.

This checklist incorporates the current-state evaluation without changing the
v6 link-history model. The priority is making the existing filesystem-style
continuation API safe and useful in a real session, then making its release
artifact reproducible.

## Result projection policy

Public command results should describe the user's current operational state,
not internal SQLite history. `current_dir` is the common state token for every
session-bound command. It gives the active path and whether `..` is available,
but does not repeat the whole work payload.

`current_work` belongs to `pwd`. It is the deliberate request for the full
work fields at the active path. A caller that has made several small changes
can call `pwd` once to resynchronise instead of receiving the same payload on
every acknowledgement.

Commands fall into four fixed result classes. Do not add a broad `verbose`
flag unless real usage demonstrates a missing class.

| Class | Commands | Result contents |
| --- | --- | --- |
| State acknowledgement | `cd`, `mkdir`, `edit`, `mv`, `fork` | `current_dir` plus a compact operation result: target path/name, changed fields, move source/destination, or fork session ID. No full current work. |
| Terminal acknowledgement | `close` | `current_dir` plus the closed path, terminal status, and submitted summary. This confirms the stack pop without repeating the parent work. |
| Focused query | `ls`, `search`, `rev-list` | `current_dir` plus only the requested entries, matches, or revision metadata. Search matches need a concise field-aware snippet, not an entire work record. |
| Recovery, decision, or detailed inspection | `pwd`, `briefing`, `proposals`, `decide-proposal`, `rev-show` | The complete projection relevant to the request. `pwd` exposes current work; `briefing` exposes the active ancestry; `proposals` exposes proposal patches and bases; `decide-proposal` exposes before/after target work and decision outcome; `rev-show` exposes the selected historical work and direct children. |

The lifecycle hooks use the rich class intentionally:

- `SessionStart` first calls `pwd`, then `briefing`.
- `SessionStart(source=compact)` injects the briefing plus the pending proposal
  before ordinary state mutation.
- `PreCompact` obtains the current work and immutable context lookback, but
  produces a proposal rather than directly changing state.
- `Stop` uses a compact unresolved-count/status query; it does not inject a
  briefing or force another turn.

`briefing` must include, for every active-ancestry node, path, kind/title,
objective, rationale, current state, open questions, return condition, and
references. For closed direct children it must include path/title, terminal
status, and closure summary or final state. This is the recovery record: it
must explain both why the active detour exists and what completed detours
imply.

## Release and source boundary

- [ ] Keep `dist/` and every generated test bundle ignored and out of Git.
- [ ] Restore and track authored test sources; `build.mjs` must not reference a
  missing test entry point.
- [ ] Replace documentation that says to commit `dist/`.
- [ ] Add a reproducible staging/package command that copies the plugin source,
  generates contracts, builds the Node runtime, and validates the staged plugin
  layout.
- [ ] Run tests against that staging artifact, including MCP and hook launch.
- [ ] Make manual marketplace installation use the staged artifact, not a
  source checkout that lacks generated runtime files.

## Continuation fidelity

- [ ] Implement the rich briefing projection above and add a nested
  detour/closed-child fixture.
- [ ] Define an explicit root-placeholder predicate: blank objective,
  rationale, or return condition means the root needs initialization.
- [ ] Update the bundled skill to use that predicate rather than referring to
  obsolete generic initialization text.
- [ ] Reject terminal `status` values in `edit`; terminal transitions must go
  through `close` so descendant checks and cursor-pop behavior cannot be
  bypassed.
- [ ] Keep `blocked` and `open` editable through `edit`; they are not terminal
  transitions.

## Lifecycle and retry safety

- [ ] Canonicalize the workspace path before constructing a SessionStart
  idempotency key, and validate supplied `cwd` before accepting a replay.
- [ ] Generate an idempotency key once per logical mutating RPC command; reuse
  it only if that same command is retried.
- [ ] Retry only connection, timeout, endpoint, or daemon-start failures. Do
  not restart the daemon and resend after a typed command failure.
- [ ] Ensure receipt replay returns the original mutation result without
  advancing the session revision or appending a second event.
- [ ] Add fixtures for changed-cwd resume, duplicate SessionStart, and a lost
  response after a successful mutation.

## Compaction and recall

- [ ] Turn hook-journal transcript offsets into real per-transcript cursors.
  PreCompact reads the unreconciled delta, capped at 48 KiB, then advances the
  checkpoint only after recording the worker attempt.
- [ ] Preserve fingerprint and diagnostic data when an offset is invalid or a
  transcript was rotated; fall back to structural context rather than failing
  compaction.
- [ ] Include open questions, return condition, reference labels/values, and
  searchable metadata in model-level search.
- [ ] Provide concise field-aware search snippets so query results remain
  compact even after the searchable surface expands.
- [ ] Clean an ephemeral shell data directory when its shell exits normally;
  leave a diagnostic message if cleanup fails.

## Regression gates before a daily trial

- [ ] Source typecheck, authored tests, staged-artifact build, and staged
  plugin validation pass from a clean checkout.
- [ ] Root -> nested detour -> close child -> briefing reports the rationale,
  open questions, return condition, and child closure outcome.
- [ ] `edit {"status":"done"}` fails; `close done "..."` succeeds only when
  every reachable descendant is terminal.
- [ ] A transport retry creates exactly one new session revision and one event.
- [ ] A compact SessionStart with a changed `cwd` fails clearly rather than
  replaying a stale registration receipt.
- [ ] Search finds text in every intended work field and produces bounded
  snippets.
- [ ] Existing v6 frozen-fork, link-history, move/rename, history-browser,
  shell, hook, browser, and daemon-restart coverage remains green.

## Suggested implementation order

1. Source/test/staged-artifact boundary.
2. Briefing and root initialization fidelity.
3. Terminal-status and retry/workspace invariants.
4. Journal-backed compact delta, expanded search, and ephemeral cleanup.
5. Full regression and a manual daily-trial session.
