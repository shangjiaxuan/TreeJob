# Context Tree v5 — session-scoped inode materialization

Date: 2026-09-13

Status: superseded by the v6 link-history model. v3, v4, and v5 databases
remain legacy data; see `context-tree-link-history-model.md` for the active
storage direction.

## Identity, records, and snapshots

The model distinguishes three internal identities:

```text
NodeId       stable logical continuation scope, like an inode
LinkId       stable named directory placement
RecordId     immutable materialization of one NodeId
```

Every materialized node is a directory record. The old work payload is stored
as directory attributes; child and parent links describe topology:

```text
DirectoryRecord
  nodeId
  attributes: WorkFields
  children: [{ linkId, name }]
  parents:  [{ linkId, parentNodeId, name }]
```

`links_v5` maps a stable LinkId to its child NodeId. Records never point to
other RecordIds. This avoids recursive rewrites when a child receives a new
materialization.

## Session revision views

The public historical identity is session-local:

```text
{ sessionId, revision }
  -> immutable Snapshot
  -> NodeId -> visible RecordId
```

Snapshot IDs are global storage locators, not public history. A fork starts at
`r0` pointing to the parent snapshot; later snapshots may materialize the same
NodeId differently in each session.

Traversal follows logical identities in the selected view:

```text
parent record child LinkId
  -> links_v5 child NodeId
  -> resolve(selected snapshot, child NodeId)
  -> visible child record
```

Therefore editing one child creates one new child record and one overlay entry;
the parent record remains unchanged. Structural operations update only the
directories and child parent-link record whose logical relationships changed.

## Publication boundary

One controller transaction writes any new records, creates one snapshot overlay,
advances the session head/cursor, appends a session event, and saves the command
receipt. A record becomes observable only after a snapshot selects it.

`session_events_v5` owns the public `r0..head` mapping. Cursor-only operations
append an event without a public revision or snapshot. The session row owns the
live cursor path and head view.

The public command protocol remains v4. Node, link, record, and snapshot IDs
remain internal.
