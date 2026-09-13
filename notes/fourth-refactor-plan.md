# Context Tree v4 — Snapshot-First Persistent Filesystem

## Summary

Replace v3’s recursive composite-revision tree with a clean `context-tree-v4.sqlite` database and protocol v4. Public history is a linear per-session snapshot timeline (`r0`, `r1`, …); immutable node, directory, entry, and payload revisions remain internal.

Every mutating command creates one cheap snapshot overlay. Cursor-only navigation creates no snapshot.

## Persistent model

- Keep stable `NodeId` and `EntryId`; directory membership refers to stable child node identity, never a child node revision.
- Retain immutable payload, directory, entry, and paired node revisions internally.
- Redefine snapshots as `{ rootNodeId, parentSnapshotId }` plus immutable `nodeId → nodeRevisionId` overlay rows.
- Add session revision mappings: each session has public `r0..head`, mapped to internal snapshots. Forks begin at `r0` sharing the parent’s fork-point snapshot.
- Resolve all reads from a selected snapshot first, then stable node/entry identity. Use a daemon-local resolved-snapshot cache; do not persist full materialized state or add checkpoint compaction in v4.
- Replace recursive ancestor path-copying with direct snapshot deltas:
  - `edit` / `close`: target node only.
  - `mkdir`: new child and direct parent directory.
  - `mv`: source and destination directories only.
  - `cd`: cursor only.
- Preserve cursor entry-ID paths and repair them when a moved subtree contains the cursor.
- Leave v3 data untouched; no migration or dual-read support.

## Public command and browser behavior

- Keep the single MCP/RPC `command` envelope and private `hello`; bump the protocol version and regenerated schema digest to v4.
- Change public revision semantics:
  - `rev-list [path] [--reference=N]` lists only session snapshots where the referenced node’s work, children, name, or location changed.
  - `rev-show <revision> [path] [--reference=N]` renders the stable target as it existed in that session revision.
  - `ls [path] [--revision=N] [--reference=N]` supports historical directory inspection needed by the browser.
- Default `reference` to the session head. Resolve a supplied path there, then render that stable identity in the selected snapshot. This preserves semantic history across rename and move.
- Snapshot-read results retain live `current_dir` and add `view_path` for the selected historical location. They expose no snapshot, inode, or storage revision IDs.
- User-facing revision rows use semantic change labels such as work, children, renamed, and moved; payload/directory implementation categories are removed.
- `search --scope=history` searches only the active session’s `r0..head` timeline and includes the matching session revision in each result. Workspace/global search remains current-head based.
- Update the read-only browser so `?revision=N` selects a session revision and optional `?reference=N` controls path identity lookup. Historical pages link using their selected revision as reference, so browsing follows historical names and topology.
- If an identity was created after the selected revision, return a clear “did not exist in this revision” result rather than a misleading path error.

## Controller, repository, hooks, and proposals

- Keep the MVC boundary: repository owns v4 rows/transactions/codecs; model resolves snapshot state and filesystem semantics; controller atomically persists overlays, session revision advancement, cursor, journal transition, and idempotency receipt.
- Replace root-node-revision mutation results with a snapshot delta keyed by stable node identity.
- Proposal records retain internal source snapshot, target node, and base node revision. Accept/replacement applies to the stable target even if the cursor moved, but conflicts if that target’s visible node revision changed.
- Keep hooks and browser as daemon clients only. Hooks continue to bootstrap current head state and submit proposal-only compact/subagent results; no hook-journal ownership changes.
- Keep opt-in diagnostics, updating internal references to report before/after snapshot and public session revision metadata.

## Validation and documentation

- Add tests for direct overlay mutations, unchanged ancestor revisions, frozen forks, session-local revision timelines, cursor repair, and snapshot resolution after daemon cache rebuild.
- Test semantic move/rename history, historical path references, absent-before-creation behavior, `view_path`, historical `ls`, and session-history search.
- Test proposal acceptance after unrelated snapshot changes and conflict after target changes.
- Update browser tests for `revision`/`reference` navigation, plus command discovery, shell grammar/help, hook/idempotency, build, plugin validation, and marketplace runtime checks.
- Update the README, bundled skill, and snapshot-model note to describe snapshot-first history and the v3-to-v4 clean cutover.
