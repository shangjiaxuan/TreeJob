# Context Tree

Context Tree is a local persistent continuation notebook for Codex. Its v8
storage model separates stable inode and link identities from the lightweight
physical records that materialize their work and topology. A public
per-session timeline (`r0`, `r1`, ...) publishes those physical record IDs.
Each revision is a frozen `{session, revision}` view; it is not an event-log
replay.

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

Every state mutation first writes unreachable physical payload, node, or link
records, then reserves its next session revision and publishes only its changed
record IDs. `cd` changes only the cursor. A sparse session-span table freezes
fork ancestry, so resolution makes bounded indexed probes: it seeks a visible
published inode or link record in the applicable span and only then follows the
frozen source span. Events are diagnostics, never state. A child work update
therefore publishes one node reference without rewriting its parents; a rename
or move publishes link references without rewriting the child work.

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
