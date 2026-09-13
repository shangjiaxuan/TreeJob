# Context Tree v6 — Link-History Views

## Summary

Replace v5’s snapshot-overlay directory records with a clean `context-tree-v6.sqlite` model.

A session revision `{sessionId, revision}` is an immutable historical view/snapshot reference. Node work state and directory topology are independent history streams, resolved as-of that explicit view. Public protocol v4, the single `command` MCP tool, shell syntax, hooks, and browser behavior remain unchanged.

## Persistent model and resolution

- Keep stable integer `NodeId` and `LinkId`.
  - `nodes_v6` records logical-node creation provenance.
  - `links_v6` permanently binds each `LinkId` to its child `NodeId`, with creator session/revision provenance.
- Replace `directory_records_v5`, `snapshots_v5`, and `snapshot_overrides_v5` with:
  - `node_records_v6(node_id, session_id, revision, work_json, created_at)`;
  - `link_records_v6(link_id, session_id, revision, parent_node_id, name, created_at)`;
  - unique `(node_id, session_id, revision)` and `(link_id, session_id, revision)` constraints.
- Store `root_node_id`, `parent_session_id`, and immutable `parent_session_revision` on sessions. Revision-bearing event rows are the lightweight snapshot/checkpoint records; remove separate snapshot IDs and tables.
- A `NodeStateRef` or `LinkStateRef` is `{id, sessionId, revision}` and resolves with a recursive SQLite CTE:
  - choose the latest local state at or before the requested revision;
  - otherwise follow the session’s frozen fork base;
  - never consider later changes in a parent or sibling session.
- Add branch-local successor queries for nodes and links: first local state strictly after a selected revision. Use them internally for validity intervals, history comparison, and diagnostics; do not expose them through MCP.
- Resolve effective directory membership from link history, not from node records. `listLinks(parentNodeId, view)` selects each link’s effective history row in the view, filters by parent, and joins its stable child `NodeId`.
- A snapshot is therefore a fixed `{rootNodeId, sessionId, revision}` view. It never uses a daemon’s live head, but it remains cheap because it does not copy a full tree.

## Model and controller changes

- Simplify node records to validated `WorkFields` only; remove persisted `children_json`, `parents_json`, forward/reverse symmetry checks, and ancestor path-copying.
- Rework filesystem operations:
  - `edit` and `close` append one node-history row;
  - `mkdir` creates a node, a stable link, one node-history row, and one link-history row;
  - `mv`/rename append one link-history row only;
  - `cd` remains cursor-only;
  - `ls`, path traversal, search, terminal-descendant checks, briefing, and browser views resolve topology through effective link history.
- Keep cursor paths as `LinkId[]`; resolve `..`, moved paths, and historical locations through the selected view’s link records.
- Reserve the next session revision inside the controller transaction before any mutation. The model writes all node/link states tagged with that revision; the controller advances the session head, writes one revision event, appends the journal transition, and saves the idempotency receipt atomically.
- Forks create `B:r0` with a frozen `{parentSessionId, parentRevision}` base and copy no node or link history rows.
- Update proposals to store source `{sessionId, revision}` and the target’s concrete base node-state reference. Acceptance conflicts only when that target’s effective node state changed.
- Preserve internal support for multiple `LinkId`s targeting one `NodeId`, but add no public `link` command or node-ID-facing API in v6.

## Public behavior, diagnostics, and documentation

- Preserve protocol version 4 and its schema digest; no public operation names, MCP tool input, shell grammar, hook payloads, or browser URLs change.
- Preserve semantic `rev-list` output:
  - compare work through node history;
  - compare direct effective child links for `children`;
  - derive `renamed` and `moved` from link-history location;
  - do not report ancestor changes merely because a descendant’s work changed.
- Replace snapshot/overlay diagnostic fields with session revision views plus before/after node/link state references.
- Create a new storage-model note and update README and bundled skill to explain the distinction between node history, link history, frozen views, and branch-local successor lookup.
- Use clean `context-tree-v6.sqlite`; retain v5 untouched and do not migrate it. Bump the plugin/package release version to `0.6.0`.

## Validation

- Test floor and successor resolution across local history, frozen forks, and sibling branches; parent-session future states must never leak into a fork.
- Test that child work edits write only node history, while rename/move writes only link history; effective later `ls` still observes the changed child state without parent rewrites.
- Test multiple internal links to one node resolve to the same later node state in a selected view.
- Test path navigation, escaped names, collision and self-descendant move rejection, cursor repair, terminal checks, history search, revision browsing, and stale proposal conflicts.
- Retain idempotency, transaction rollback, hook, browser, shell, daemon restart, build, marketplace-layout, and bundled-runtime validation.
