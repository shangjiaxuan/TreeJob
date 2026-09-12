# Context Tree v3 — Filesystem-Style Persistent Node API

## Summary

Replace the experimental v2 record API with a clean v3 SQLite layout and protocol v2. The public MCP interface becomes a cursor-relative virtual filesystem (`pwd`, `ls`, `cd`, `mkdir`, `mv`, revisions), while immutable node, payload, directory, and entry revisions remain internal implementation objects.

Keep `context-tree-v2.sqlite` untouched. Create and use `context-tree-v3.sqlite`.

## Core model and persistence

- Introduce stable SQLite identities for `Node` and `Entry`, plus immutable `NodeRevision`, `PayloadRevision`, `DirectoryRevision`, and `EntryRevision` records.
- Define a node revision as the pairing of one payload revision and one directory revision. `rev-list` defaults to this chronological node-revision history and labels each revision as payload, directory, or both.
- Store ordered directory memberships separately. Each membership binds an entry revision to the exact child node revision visible in that directory revision.
- Store snapshot roots as node-revision IDs. Store session cursors as stable entry-ID paths from root, not payload-revision IDs.
- Replace v2’s recursive payload search/successor resolution with path-directed lookup and COW over the known entry path. Mutations may copy affected ancestor entry lists, but must not traverse, materialize, or rewrite unrelated descendants.
- Implement `mv` by path-copying only source/destination ancestor paths to their lowest common ancestor. Same-name moves preserve entry and node identities; rename creates an entry revision; payload revisions remain unchanged.
- Normalize names to Unicode NFC and compare case-sensitively. Store arbitrary non-empty Unicode names except NUL. Path parsing uses `/` as separator and `\` escapes literal special characters; canonical rendering escapes `/`, `\`, and literal `.`/`..` segments.
- Keep every node’s payload present but allow empty work fields. Default `kind` is `node`; title is an optional human-facing field independent of the path name.

## Public protocol and operational layer

- Add a `FilesystemOperations` facade between RPC/MCP adapters and the transaction controller. It exposes compact filesystem projections and hides snapshots, physical IDs, predecessors, receipts, and COW mechanics.
- Replace public v2 record operations with:
  - `pwd`: idempotently initialize a missing session when `cwd` is supplied; otherwise return current directory and work.
  - `ls`: list direct child entry summaries, optionally at a relative/absolute path.
  - `cd`: resolve relative/absolute paths, including `.`, `..`, and escaped segments, and move the cursor.
  - `mkdir`: create a named child node with optional payload fields; remain in the parent.
  - `edit`: patch the current node payload.
  - `mv`: accept shell-style source and destination paths; destination may be an existing directory or a new final name.
  - `close`: require summary and terminal status, reject nodes with non-terminal descendants, then pop to the parent except at root.
  - `search`: default to the current subtree; support explicit session, workspace, global, and historical scopes.
  - `rev-list` and `rev-show`: inspect the current node’s persistent node-revision lineage.
  - `fork`: create a frozen child session from the current snapshot/cursor.
  - `briefing`: return the compact-recovery ancestor projection.
  - `proposals` and `decide-proposal`: expose pending compact/subagent candidate review and decisions, but not public candidate creation.
- Every public result includes top-level `current_dir` and `current_work`; operation-specific data such as `entries`, matches, revision rows, or proposal rows is additive.
- Keep `sessionId` explicit in public MCP inputs. Remove `commandId` from public operation schemas; carry hook idempotency keys in JSON-RPC envelope metadata, outside the MCP tool surface.
- Make `pwd` validate a supplied `cwd` against an existing session’s workspace rather than silently rebinding it.
- Update the contract generator and registry to support quoted hyphenated operation names such as `rev-list` and `decide-proposal`; bump `PROTOCOL_VERSION` to 2 and regenerate the schema digest.

## Adapters, hooks, diagnostics, and docs

- Keep daemon socket framing, MCP, hook, and shell code as adapters only. The shell continues to pass operation names and JSON-compatible parameters directly to the daemon, with local `help`/`exit` utilities only.
- Update SessionStart and SubagentStart to bootstrap through `pwd`, then request `briefing`. Keep PreCompact proposal-only, targeting the current node revision; keep subagent completion as a parent-visible proposal.
- Replace Stop’s dependency on full context with a compact internal status/briefing query.
- Add daemon-owned opt-in diagnostics: `CONTEXT_TREE_DEBUG=1` appends structured JSONL records to one local development log file. Log session ID, operation, idempotency key, result/replay/error, duration, cursor depth, and before/after snapshot/node-revision references; omit record content by default. `CONTEXT_TREE_DEBUG_CONTEXT=1` additionally logs redacted payloads.
- Update the bundled skill, README, plugin descriptions, shell help, and the operational-direction note to describe node/entry filesystem semantics and the path-copying invariant.

## Validation

- Test identity and revision separation: payload edit, directory edit, same-name move, rename, create, close, fork, and proposal acceptance.
- Test path-directed COW: unaffected sibling revisions/subtrees remain shared; only the union of affected ancestor paths receives replacement revisions.
- Test cursor repair when the current node or one of its ancestors is moved; verify frozen forks retain their original path and revisions.
- Test Unicode NFC/case-sensitive name uniqueness, escaped paths, reserved segments, absolute/relative navigation, destination collision, root move rejection, and self-descendant move rejection.
- Test compact public outputs contain `current_dir`/`current_work` and omit internal snapshots/inode/predecessor fields; validate MCP discovery exactly matches the filesystem operation set.
- Test idempotency replay through RPC metadata, hook bootstrap/briefing, proposal stale conflicts, debug log opt-in behavior, build, plugin validation, and a shell integration flow.

## Assumptions

- This is a clean v3 database cutover; v2 databases and their data remain untouched and are not migrated.
- Directory entries have stable identity across moves; a node has both its own payload and child directory, even when that payload is initially empty.
- `mkdir` stays in its parent, while `close` performs the continuation-stack pop.
- The initial ordered-directory representation may copy direct membership lists; persistent B-tree optimization is deferred.
