# Context Tree operational API direction

Date: 2026-09-13

Status: implemented as the Context Tree v3 public protocol. This note remains
the user-facing semantic rationale for the filesystem interface.

## Intent

Context Tree is a persistent, cursor-relative execution notebook. Its storage
needs immutable payloads, directory metadata, snapshots, COW lineage, cursors,
receipts, and proposals. Those are implementation mechanisms. They should not
be the normal user or agent-facing protocol.

The public API should feel like a small stateful filesystem notebook:

    current_dir:
    current_work:

Normal results explain where the caller is and the work at that location. More
of the tree is retrieved deliberately through navigation and inspection
operations rather than echoed after every mutation.

## Public projection policy

Normal MCP results should contain compact current-relative state:

    current_dir:
      path:
      can_go_back:

Only `pwd` includes the active `current_work` payload. Other operations retain
`current_dir` as their orientation context and return only their focused data:
for example, `ls` entries, search matches, a revision, or a briefing. This
avoids repeating a full work payload after every ordinary mutation.

Snapshot IDs, inode IDs, predecessor links, history versions, raw active-path
copies, whole unresolved-record lists, and duplicated ancestor briefings remain
internal. They must not appear by default in a normal result.

The existing full Context projection is useful as a diagnostic artifact, but it
is not the appropriate public result shape.

## User-facing filesystem interface

The public abstraction is a persistent filesystem notebook, not a veneer over
unrelated storage mechanics. A session is a checkout with a current working
directory. The cursor is pwd. A work scope is a named directory entry with a
current work payload.

The core public operations should follow shell semantics:

- pwd: return current path and current work; this is the default state read;
- ls: list concise entries in the current directory;
- cd: enter a listed child, a parent, or eventually an absolute notebook path;
- create or mkdir: create a child work scope with objective, rationale, and
  return condition;
- edit: patch the current work payload;
- mv: relocate or rename a directory entry;
- close or abandon: apply semantic terminal status while retaining history;
- search: search an explicitly selected scope;
- rev-list: list persistent work revisions at the current path;
- rev-show: inspect a selected persistent work revision;
- fork: create an independent session checkout;
- briefing: request the richer recovery-oriented ancestor projection.

Every mutation should return `current_dir` plus any small operation-specific
result. Call `pwd` when the current work payload is needed. This keeps the
caller oriented without returning either the whole tree or a duplicate payload.

The exact child-selection mechanism is still open. Candidates are an explicit
unique directory name, a path component, or an opaque entry token returned by
ls. Raw inode IDs should not be required for ordinary navigation.

### Identity, revision, and move semantics

The public model has no file-versus-directory distinction. Every named node
has its own work payload and a directory of child nodes. A leaf simply has an
empty child directory; a grouping node may have minimal or empty work fields.

The persistent model must keep these concepts distinct:

    node identity
      node revision
        payload revision
        directory revision
          directory membership
            entry identity
            entry revision
            child node revision

- Node identity is the durable identity of a work scope.
- A node revision is an immutable pairing of one payload revision and one
  directory revision. It is the normal user-facing meaning of revision.
- A payload revision contains the node's own work fields.
- A directory revision contains the ordered child memberships of that node.
- An entry identity is the durable identity of a named membership. Its
  revision holds the entry name and entry-local metadata.
- A membership resolves an entry revision to the exact child node revision
  visible in that directory revision.

Rev-list at the current path should list node revisions by default. Each item
can identify whether its payload, directory, or both changed. Focused
inspection may expose payload, directory, or entry revision details without
confusing those component histories with the node history.

    create /goal/job/check-migration
      creates node, payload, directory, and entry identities

    edit current work
      new payload revision and node revision

    mv /goal/job/check-migration /goal/archive/check-migration
      moved node and entry identities remain the same
      source and destination containment revisions change

    mv check-migration archive-check
      same entry and node identities
      new entry revision carries the new name

Therefore:

- editing title, objective, rationale, state, or other work content creates a
  new payload revision and node revision;
- moving an entry without rename preserves both entry and node identity;
- path rename creates an entry revision, distinct from changing the work
  title;
- directory and snapshot history stay internally available for COW and
  diagnostics, but are not conflated with normal work-content history.

### Immutable path-copying caveat

Immutable snapshot updates are path-copy operations, not in-place tree edits.
Editing a node payload, changing a directory membership, or moving an entry
creates replacement revisions only along affected paths to the session root.
Unchanged subtrees remain shared by reference.

For example, a payload edit creates a new leaf payload and node revision. Its
parent directory receives one changed child-node reference, then a replacement
parent node revision. The same replacement continues only through ancestors to
the session root. A same-name move instead replaces source and destination
directory memberships while retaining the moved entry and node identities.

The initial ordered-directory implementation may copy the direct child-entry
list of each affected ancestor. It must never recursively materialize or
rewrite unrelated descendants. A persistent B-tree optimization for very large
directories is deferred.

## Navigation and focused retrieval

The operational layer should expose fixed, cursor-relative operations instead
of returning a whole state projection each time:

- Navigation and focused retrieval are supplied by the filesystem operations
  above, rather than by returning a whole state projection after every action.

Mutations such as create child, update, close, and proposal decision return
the current directory projection. `pwd` is the focused payload read.

## Architecture boundary

The desired layering becomes:

    MCP, hook, shell, future UI adapters
            ->
    operational facade: cursor-relative commands and compact projections
            ->
    continuation controller: transaction, receipts, workflow orchestration
            ->
    continuation model: COW tree and cursor semantics
            ->
    record repository: SQLite mechanics

The continuation model and repository retain snapshots, inodes, and lineage.
The operational facade translates them into the notebook interaction model.
The controller should not merely pass the model Context projection through to
the protocol.

The development shell remains a faithful protocol client: after the public
protocol is compact, it should display that exact compact result. `exit` and
`quit` remain local shell utilities. Daemon-owned `help` is deliberately not:
it uses the same command envelope and lists the same public commands that MCP
tool discovery exposes.

## Unified command transport

Protocol v3 exposes one MCP tool, `command`, and one non-handshake daemon RPC
method with the same input shape:

```json
{
  "sessionId": "session-123",
  "command": ["mkdir", "detour", {"returnCondition":"Report findings"}]
}
```

The first atom selects a filesystem operation. Remaining atoms are positional
when their meaning is unambiguous; raw JSON objects and arrays carry structured
payloads. Ambiguous optional values use normal long options, accepting both
`--scope=workspace` and `--scope workspace`. The daemon owns argv validation
and converts a command to an internal controller use case. The shell only
lexes text into this JSON-compatible array; hooks construct the array directly.

Shell quoting is a separate lexical layer from Context Tree path escaping:

- double-quoted strings support `\"` and `\\`;
- balanced `{...}` and `[...]` atoms are parsed as JSON;
- other backslash sequences are preserved for the daemon path parser.

`help` and `help <command>` are sessionless. All operational commands require
a session ID. Internal lifecycle proposal submission uses the same transport
but is intentionally absent from MCP discovery and help.

## Restore briefing

The richer ancestor briefing is still valuable after compact and after returning
from a detour. It should be an explicit focused projection, used by lifecycle
hooks and available through a dedicated operation, rather than embedded in
every normal response.

It should surface only the information needed to resume:

- the active goal and rationale;
- relevant provenance where the record carries it;
- the current work, state, and return condition;
- a completed-detour outcome when relevant;
- open questions;
- pointers to durable logs and notes.

Logs and notes remain the authority for material engineering facts. Context
Tree supplies navigation, execution state, and concise pointers.

## Local diagnostic logging

Retain rich internal visibility through an opt-in daemon-owned structured log,
not by bloating MCP responses.

Enable normal diagnostics with CONTEXT_TREE_DEBUG=1. Each JSONL record should
include at least:

    timestamp
    session_id
    operation
    command_id
    result: success | replay | error
    duration_ms
    cursor_depth_before
    cursor_depth_after
    head_snapshot_before
    head_snapshot_after
    error_code

This is enough to diagnose navigation, COW, receipt replay, stale proposals,
and transaction failures. It should not log record content by default.

An explicitly stronger CONTEXT_TREE_DEBUG_CONTEXT=1 mode may log redacted
input and output snapshots for a failing session. This must remain opt-in
because record data can contain workspace paths, user text, and notes.

The diagnostic log is separate from both the continuation SQLite database and
the hook-journal database.

## Read-only browser

An optional loopback-only browser is a debugging view, not another persistence
owner. It receives its session identity from a small local landing page, stores
that identity in a `SameSite=Strict` cookie, and composes its page by calling
the existing read-only filesystem commands (`ls`, `rev-list`, and `rev-show`).
The browser-specific tree/page projection is therefore local adapter state,
not a daemon contract. The HTTP adapter never opens SQLite or offers mutation
routes.

## Deferred decisions

- Directory entry naming and disambiguation policy.
- Whether briefing is one operation or a hook-specific projection.
- Exact compact current-work fields and outcome presentation after back.
- Debug-log location, retention, rotation, redaction rules, and failure policy.
- Choice and design of user-interface tools.
