# Context Tree

Context Tree is a local persistent continuation notebook for Codex. Its v6
storage model separates logical node work from directory topology: nodes are
inode-like continuation identities, while stable links own historical names and
placements. Public history is a per-session timeline (`r0`, `r1`, ...), where
each revision is a frozen `{session, revision}` view.

Source checkouts contain only authored files. Build the ignored staged
marketplace artifact before installing it in Codex; the artifact bundles its
Node 22+ runtime and does not retain development dependencies.

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
Unicode NFC and case-sensitive. `mv` retains stable node and directory-link
identity for a same-name move or a rename. Record and snapshot IDs are internal
implementation details.

Every state mutation creates one lightweight session revision, while `cd`
changes only the cursor. Node work updates append node history; `mkdir`, moves,
and renames append link history. A selected revision resolves both histories
as-of that fixed view, so a child work update is visible through every active
link without rewriting parent directories. `rev-list [path] [--reference=N]`
reports semantic work, child, rename, and move history.
`rev-show <revision> [path] [--reference=N]` resolves the path identity at the
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
for an existing Context Tree session ID, stores it in a local `HttpOnly`,
`SameSite=Strict` cookie, and redirects to `/browse/`. Browse a node directly
with `http://127.0.0.1:<port>/browse/<path>`; add `?revision=<id>` to inspect a
historical session revision. Add `?reference=<id>` when the URL path should be
resolved against a historical state rather than the session head. The page is
read-only and queries the daemon instead of opening SQLite.

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
