# Context Tree

Context Tree is a local persistent continuation notebook for Codex. Its v9
model is a shared workspace filesystem: sessions are users on a shared `main`
branch, rather than private branches. Stable inode and link identities remain
separate from immutable physical payload, node, and link records. Mainline
revisions publish physical record IDs; events are diagnostic only, never a
state-replay source.

Source checkouts contain only authored files. Build the ignored staged
marketplace artifact before installing it in Codex; the artifact bundles its
Node 22+ runtime and does not retain development dependencies.

## Development shell

The shell is a development-only integration harness. It, lifecycle hooks, the
browser, and Codex's STDIO bridge are independent MCP clients; none opens the
continuation database itself.

The daemon owns the local Streamable HTTP MCP endpoint at
`http://127.0.0.1:43177/mcp` by default. Set `CONTEXT_TREE_MCP_PORT` to use a
different fixed port. `CONTEXT_TREE_MCP_PORT=0` is for manually managed runs;
clients then require an explicit loopback `CONTEXT_TREE_MCP_ENDPOINT` ending in
`/mcp`.

There is one normal daemon per OS user, not one per client or data directory.
Concurrent clients invoke the same daemon executable; its single startup-gate
winner claims the user-local owner lease before it opens SQLite. Other starts
exit without initializing daemon state. A data-directory override selects that
daemon's database only when it is first started; it does not create an
independent daemon.

Install development dependencies and start a disposable notebook. Disposable is
the default, so the short command is enough:

    npm ci
    npm run shell

To keep a development notebook between shell invocations, name its data
directory explicitly:

    npm run shell -- --data-dir C:/temp/context-tree-trial

Pass `--session-id test_session` to reuse a known session ID; otherwise the
shell generates one for its own lifetime.

MCP exposes one tool, `command`. Its input is a session ID plus the same
JSON-compatible command array used by hooks and the development shell:

```json
{
  "sessionId": "notebook-trial",
  "command": ["mkdir", "migration", {"objective": "Ship it"}]
}
```

The shell prints the exact compact daemon result. Its commands are:

    pwd C:/work/repo
    mkdir migration {"objective":"Ship it"}
    cd migration
    edit {"currentState":"Checking schema safety"}
    publish
    proposals --scope=inbox
    decide-proposal mailbox . collaborator-session accept
    rev-list /migration
    close done "Checked migration safety"
    search migration --scope=workspace
    help search
    quit

The shell supplies one generated session ID for its lifetime. `help` is sent
to the daemon without a session and lists only MCP-visible commands. Positional
arguments are used where unambiguous. `search` accepts either
`--scope=workspace` or `--scope workspace`. Use double quotes for strings with
spaces; within them `\"` and `\\` escape a quote and backslash. JSON objects
and arrays are raw, balanced JSON arguments. The shell preserves other
backslash sequences for Context Tree path parsing.

Paths use `/`; `\\` escapes literal `/`, `\\`, `.` and `..` names. Names are
Unicode NFC and case-sensitive. `mv` retains stable node and directory-link
identity for a same-name move or a rename. Record and snapshot IDs are internal
implementation details.

Every mainline mutation first writes unreachable physical payload, node, or
link records, reserves the next shared-branch revision, then publishes only
the changed record IDs. `cd` changes only the session cursor. A private edit
creates a session overlay when the caller lacks the appropriate inode
capability, or when `--local` is supplied. `publish [path]` makes the latest
overlay visible in the inode owner's mailbox; it never changes `main`.
`decide-proposal mailbox <path> <author-session> accept` validates the
candidate base record and publishes one authoritative mainline revision.
Rejected, withdrawn, and accepted mailbox pointers do not delete the author's
draft records.

`set-identity <user-id> [groups-json] [metadata-json]` sets the trusted local
PoC identity before `pwd` attaches the session to a workspace. `chmod
<content-octal> <topology-octal> [path] [--group=<group>]` lets an inode owner
set separate content and topology capabilities. For example, a directory with
group topology write is a dropbox: group members can append children to main,
while those child inodes remain owned by their creators. `ls -a` (or `ls
--briefing`) gives bounded direct-child briefings; `cd` returns an active-path
briefing for its destination.

`rev-list [path] [--reference=N]` reports semantic work, child, rename, and
move history. Add `--verbose` to include the originating `{ sessionId,
revision }` view for each node state. `query-link <parent|child> [path]`
inspects a node's stable directory-link history and likewise returns its
creating views. These are distinct from the session revision timeline.
`rev-show [revision] [path] [--reference=N]` resolves the path identity at the
reference revision (the head by default) and renders it at the selected
revision. `ls` also accepts `--revision=N --reference=N` for historical
directory inspection. Session revisions are public; SQLite node, link, and
history-record IDs are not.

Set `CONTEXT_TREE_DEBUG=1` for daemon-owned JSONL diagnostics in the data
directory. It logs operation metadata but not work content. Set
`CONTEXT_TREE_DEBUG_CONTEXT=1` to include diagnostic result content.

## Read-only browser

Start the optional local browser with a random available port:

    npm run browse

Point it at a persisted Context Tree data directory, optionally with a fixed
port:

    npm run browse -- --data-dir C:/temp/context-tree-trial --port 48731

It listens only on `127.0.0.1` and prints its address. The landing page asks
for an existing Context Tree session ID and opens
`/browse/<path>?sessionId=<id>`. The browser stores no session cookie: omitting
`revision` and `reference` always refreshes the latest database head, while
adding `?revision=<id>` inspects a historical session revision. Add
`?reference=<id>` when the URL path should be resolved against a historical
state rather than the session head. The page is read-only and composes public
MCP query commands instead of opening SQLite.

## Staged marketplace artifact

After changing TypeScript source, run:

    npm run build
    npm test
    npm run validate
    npm run package-artifact

The final command creates `../../out/context-tree-marketplace/` with a
standalone `.agents/plugins/marketplace.json` and `plugins/context-tree`
runtime. Install that staged marketplace, not this source checkout. `dist/`,
generated contract metadata, and `out/` remain untracked.
