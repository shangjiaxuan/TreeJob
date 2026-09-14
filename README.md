# Context Tree

Context Tree is a Codex plugin PoC for persistent, tree-shaped continuation state. The local daemon owns the continuation SQLite database; the STDIO MCP server and Codex lifecycle hooks communicate with it over a user-local socket.

## Layout

- `.agents/plugins/marketplace.json` registers the project marketplace entry.
- `plugins/context-tree` is the authored plugin source.
- `out/context-tree-marketplace` is the ignored, generated installable marketplace artifact.

The default data directory is `%LOCALAPPDATA%\\ContextTree` on Windows, or the directory specified by `CONTEXT_TREE_DATA_DIR`. The daemon database holds continuation records; `journal/hook-journal.sqlite` holds only transcript checkpoints and worker diagnostics.

## Development

```powershell
cd plugins/context-tree
npm install
npm run typecheck
npm test
npm run validate
```

Run `npm run package-artifact` from `plugins/context-tree`, then install the
staged marketplace at `out/context-tree-marketplace`. The included skill tells
agents to inspect the active path, preserve return conditions, close detours
explicitly, and decide compact proposals before further mutations. A copyable
policy fragment is at `plugins/context-tree/AGENTS.md.snippet`.

## Current PoC boundary

The daemon supports COW session forks, scoped continuation search, terminal-descendant checks, compact and subagent proposals, and an advisory Stop hook. Compact workers propose scalar changes only; they cannot reshape the continuation tree. A parent can accept a subagent branch’s provenance/summary proposal, but structural cross-branch merge is intentionally deferred.
