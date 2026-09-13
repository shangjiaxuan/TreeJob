# Context Tree v5 — Session-Scoped Inode Materialization

## Summary

Replace v4’s component-revision schema with a directory-only persistent filesystem model in `context-tree-v5.sqlite`.

A `NodeId` is an abstract inode identity. A `RecordId` is one immutable directory materialization of that node: its work fields are directory attributes, and its links describe directory topology. A session-local revision selects a snapshot, which resolves node identities to visible records.

Keep protocol v4, the single `command` MCP tool, all existing public commands, hooks, shell grammar, and browser behavior unchanged. Leave v4 data untouched.

## Storage model

- Create `nodes_v5` as stable integer inode identities.
- Create `links_v5` as stable integer directory-placement identities, each permanently bound to one child `NodeId`.
- Create `directory_records_v5`:

  ```ts
  {
    id: RecordId;
    nodeId: NodeId;
    attributes: WorkFields;
    children: Array<{ linkId: LinkId; name: string }>;
    parents: Array<{ linkId: LinkId; parentNodeId: NodeId; name: string }>;
    createdAt: Timestamp;
  }
  ```

  The child node is obtained from `links_v5`, never from another record ID.

- Create `snapshots_v5` with `root_node_id`, `parent_snapshot_id`, and immutable `snapshot_overrides_v5(snapshot_id, node_id, record_id)`.
- Create `sessions_v5` with workspace path, head snapshot, head session revision, cursor `LinkId[]`, parent session, and timestamps.
- Replace cursor and session-revision tables with `session_events_v5`. Snapshot-changing events carry a unique `(session_id, revision, snapshot_id)` mapping; cursor-only events have null revision/snapshot.
- Retain proposals and receipts. Proposals use `{ targetNodeId, baseRecordId, sourceSnapshotId }`.
- Remove v4 workspaces, entries, payload/directory/entry/node revisions, memberships, predecessor/version chains, cursors, and session-revision tables.

## Resolution and mutation rules

- Treat `{ sessionId, revision }` as the semantic view identity. Resolve it to an internal snapshot, then resolve `NodeId → RecordId` through snapshot lineage.
- Records are storage-global and may be shared by forks, but no record points directly to another record. A link resolves through its stable child NodeId in the selected session revision.
- Path traversal is:

  ```text
  SessionRevisionRef → Snapshot → parent NodeId → parent Record
  parent child LinkId → child NodeId → selected child Record
  ```

- Use `LinkId[]` for cursors and resolved paths. The path stack defines `..`; parent arrays support validation and direct location/history queries.
- A work edit or close writes one replacement record for the target node. It does not rewrite parents or children.
- `mkdir` allocates a NodeId and LinkId, then writes one parent replacement record and one child initial record. `mv` retains LinkId and writes replacement records only for the source parent, destination parent, and moved child, updating their mirrored logical links.
- All records are inserted fully formed once. The controller publishes their node-to-record overrides, session head, cursor state, event, and receipt in one SQLite transaction.
- Validate forward/reverse link symmetry before publication. Keep the implementation DAG-capable, but preserve the current tree-only public API: no `link` command in v5, and all existing move/cycle protections remain. Future hard-link support creates a new LinkId and updates only the relevant parent/child records.

## History, adapters, and diagnostics

- `rev-list` resolves its reference path to a stable target NodeId and final LinkId. It compares selected record attributes and child links for `work`/`children`, and the same LinkId’s parent/name location for `renamed`/`moved`.
- `rev-show`, historical `ls`, search history, proposals, and browser reads resolve through the requested session revision; no public result exposes NodeId, LinkId, RecordId, or snapshot IDs.
- Rework repository codecs, model resolution/mutation logic, and controller commit orchestration. The MCP, RPC, shell, hooks, browser adapters, command registry, and generated public schemas remain behaviorally unchanged.
- Update diagnostics to log internal snapshot and record references. Update README, bundled skill, and the storage-model note with the inode/record/link/session-revision distinction.

## Validation

- Verify a parent record is unchanged when a child’s work record changes, while the same session revision resolves the child to its replacement record.
- Verify a fork shares `r0` records but independently materializes the same NodeId after divergent edits.
- Test stable LinkId rename/move history, mirrored parent/child links, cursor repair, escaped paths, and root/self-descendant rejection.
- Test transaction rollback, one-event-per-snapshot mutation, event-backed `r0..head` lookup, receipt replay, proposal conflicts against base RecordId, reopened-daemon snapshot resolution, history search, and frozen forks.
- Retain public command, hook, browser, shell, build, and marketplace validation coverage.

## Assumptions

- `context-tree-v5.sqlite` is a clean cutover with no v4 migration.
- SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` plus `RETURNING` allocates NodeId, LinkId, RecordId, and snapshot IDs.
- Work fields remain strict Zod-validated JSON directory attributes; search remains model-level.
- Internal snapshot IDs are implementation locators. Only session-local revisions (`r0`, `r1`, …) are public historical identities.
