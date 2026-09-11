# Context Tree — MVC Boundary Refactor

## Summary

Replace the current `ContextStore` god object with an explicit MVC-style backend:

```text
MCP / hooks / socket adapters
        ↓
ContinuationController
        ↓
ContinuationModel
        ↓
RecordRepository → SQLite
```

No RPC operation names, wire schemas, database filename, or continuation semantics change.

## Implementation changes

- Make `daemon-service.ts` the `ContinuationController`: protocol operation dispatch calls controller methods only; it contains no SQLite access and no COW/tree traversal.
- Extract `RecordRepository` from `store.ts`. It owns:
  - database initialization, migrations, transactions, and row codecs;
  - typed CRUD for workspaces, payload inodes, directory inodes, snapshots, sessions, cursors, journals, receipts, and proposals;
  - no cursor policy, COW path copying, terminal checks, proposal decisions, or session workflow.
- Create `ContinuationModel`, constructed with a `RecordRepository`. It owns:
  - snapshot reachability and predecessor resolution;
  - immutable payload/directory creation and path-copying;
  - cursor path validation and repair;
  - context projection, scoped search, terminal-descendant invariants, forks, and proposal candidate selection.
- Keep transactional command orchestration in the controller: deduplicate by command receipt, invoke one model use case in a repository transaction, advance session state, and append the corresponding journal event.
- Make `daemon.ts`, `mcp.ts`, and `hook.ts` views/adapters only:
  - parse host input;
  - call the controller through JSON-RPC;
  - render protocol/MCP/hook output;
  - contain no continuation decisions or persistence knowledge.
- Reformat all extracted methods with one responsibility per method, named intermediate values, and multiline conditionals/transactions. Remove compressed multi-statement lines.

## Interfaces

- Introduce a typed repository interface consumed by `ContinuationModel`; SQLite is its first implementation.
- Expose controller use cases matching the existing operation registry: session registration/context, navigation, record mutation/closure, fork, search, proposal creation/listing/decision.
- Preserve Zod schemas as the shared boundary contract. Repository codecs validate decoded rows; controller validates command input/output.

## Test plan

- Repository tests: row codec validation, transaction rollback, journal receipt replay, and snapshot persistence.
- Model tests: COW path copying, predecessor resolution, frozen forks, cursor repair, terminal checks, and scoped current-head/history search.
- Controller tests: each operation routes through the model, is idempotent when given a command ID, and records one journal transition.
- Adapter tests: MCP and hook adapters only transform input/output and cannot import repository/model persistence APIs directly.
- Retain existing schema, COW-fork, proposal, build, and plugin-validation tests.

## Defaults

- `ContinuationModel` delegates all storage through the repository; adapters never call it directly.
- `ContinuationController` is the single application entry point for daemon operations.
- The existing v1 SQLite database remains the target; this is an internal code-structure refactor, not a data migration.
