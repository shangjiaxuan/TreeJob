# Context Tree

Context Tree is a local persistent continuation notebook for Codex. Its v3
public API is a cursor-relative virtual filesystem: named nodes carry work
payloads and can contain child nodes. Immutable snapshots, node revisions,
entry revisions, and copy-on-write directory revisions remain implementation
details behind the daemon.

The plugin runtime is bundled in the checked-in dist directory. A fresh
marketplace checkout can therefore run its MCP server and hooks on Node 22 or
newer without installing development dependencies.

## Development shell

The shell is a development-only integration harness. It talks to the daemon
through the same RPC client as the MCP server and hooks; it never opens the
continuation database itself.

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
Unicode NFC and case-sensitive. `mv` retains node and entry identity for a
same-name move; a rename writes an entry revision. `rev-list` reports the
chronological node-revision line, labelling payload and directory changes.

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
for an existing Context Tree session ID, stores it in a local `HttpOnly`,
`SameSite=Strict` cookie, and redirects to `/browse/`. Browse a node directly
with `http://127.0.0.1:<port>/browse/<path>`; add `?revision=<id>` to inspect a
historical revision of that node. The page is read-only and queries the daemon
instead of opening SQLite.

## Runtime updates

After changing TypeScript source, run:

    npm run build
    npm test
    npm run validate

Commit the regenerated dist runtime with the source change. The plugin
manifest, MCP launcher, and lifecycle hooks invoke that bundled runtime.
