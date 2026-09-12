# Context Tree

Context Tree is a local persistent task stack for Codex. It keeps a
continuation tree separate from transcript history: each record describes the
current work, why it matters, what remains, when to return, and pointers to
durable logs or notes.

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

The shell displays both the compact active path and an ancestor briefing. Its
commands are:

    registerSession --sessionId notebook-trial --cwd C:/work/repo
    getContext --sessionId notebook-trial
    updateRecord --sessionId notebook-trial --patch '{"objective":"Ship it"}'
    pushChild --sessionId notebook-trial --fields '{"kind":"plan", ...}' --enter true
    closeRecord --sessionId notebook-trial --summary "Checked migration safety"
    searchContext --sessionId notebook-trial --query migration --scope session_tree
    describe
    quit

The intended trial is to initialize a goal, add a plan, job, and detour, close
the detour, and return upward. The briefing should make the next action, its
reason, open questions, evidence pointers, and closed-detour outcome clear
without rereading a transcript.

## Runtime updates

After changing TypeScript source, run:

    npm run build
    npm test
    npm run validate

Commit the regenerated dist runtime with the source change. The plugin
manifest, MCP launcher, and lifecycle hooks invoke that bundled runtime.
