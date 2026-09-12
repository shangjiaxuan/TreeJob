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

The shell prints the exact compact daemon result. Its commands are:

    pwd --sessionId notebook-trial --cwd C:/work/repo
    mkdir --sessionId notebook-trial --name migration --work '{"objective":"Ship it"}'
    cd --sessionId notebook-trial --path migration
    edit --sessionId notebook-trial --patch '{"currentState":"Checking schema safety"}'
    rev-list --sessionId notebook-trial --path /migration
    close --sessionId notebook-trial --summary "Checked migration safety" --status done
    search --sessionId notebook-trial --query migration --scope subtree
    describe
    quit

Paths use `/`; `\\` escapes literal `/`, `\\`, `.` and `..` names. Names are
Unicode NFC and case-sensitive. `mv` retains node and entry identity for a
same-name move; a rename writes an entry revision. `rev-list` reports the
chronological node-revision line, labelling payload and directory changes.

Set `CONTEXT_TREE_DEBUG=1` for daemon-owned JSONL diagnostics in the data
directory. It logs operation metadata but not work content. Set
`CONTEXT_TREE_DEBUG_CONTEXT=1` to include diagnostic result content.

## Runtime updates

After changing TypeScript source, run:

    npm run build
    npm test
    npm run validate

Commit the regenerated dist runtime with the source change. The plugin
manifest, MCP launcher, and lifecycle hooks invoke that bundled runtime.
