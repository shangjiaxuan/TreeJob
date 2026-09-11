# Context Tree — Schema-First Persistent Snapshot Rewrite

## Summary

Replace the current spike with a Zod-first, strict JSON-RPC protocol and immutable filesystem-style state model. Treat existing spike databases as legacy; create a new v1 database.

## Core model

- Use Zod schemas as the executable source of truth for domain objects, RPC inputs/outputs, hook payloads, MCP tool schemas, and SQLite codecs.
- Add typed SQLite table descriptors alongside Zod schemas. Descriptors define columns, codecs, keys, indexes, DDL, and migration versions while retaining `node:sqlite`.
- Model payload records as immutable inode-like objects with SQLite primary key, `predecessor_inode_id`, and lineage version.
- Keep containment exclusively in immutable directory metadata objects. A snapshot points to a root directory; payload records never store parent/directory ownership.
- COW mutations write new payload/directory objects and path-copy only affected directory metadata to a new root snapshot.
- A session owns a mutable `head_snapshot_id` and separate mutable cursor path. Cursor moves append journal entries but do not create tree snapshots.
- Forks copy the parent’s exact root snapshot and cursor state. Parent changes never appear in the fork.

## Protocol and operations

- Define one operation registry containing named operation schemas, generated MCP JSON schemas, JSON-RPC dispatch metadata, and typed client signatures.
- Use strict versioned envelopes plus `hello` and `describe`; clients provide protocol version/schema digest and receive a typed incompatibility error when mismatched.
- Validate all request and response payloads at transport and SQLite boundaries. Remove generic row maps, `any`, untyped operation names, and ad-hoc casts.
- Normal commands target the current cursor by default. An explicit inode target resolves its unique successor reachable from the session head through predecessor lineage.
- Run every mutation in one SQLite transaction: resolve head, validate invariants, write immutable objects, advance session head/cursor, append journal entry, and persist an idempotency receipt.
- Generate deterministic idempotency keys for lifecycle hooks. Replayed hook events return the original result rather than duplicating forks or proposals.
- Search current heads only by default; expose journal/history search separately.

## Proposals and hooks

- Store compact/subagent work as immutable candidate records or side snapshots with source snapshot, target inode, provenance, and lifecycle state.
- On proposal acceptance, path-copy from the current parent head and select either:
  - an existing candidate record, or
  - a new record materialized from an explicitly supplied replacement.
- Never perform semantic or automatic three-way merge. Preserve rejected/stale candidates as historical objects and journal entries.
- Keep hook transcript offsets, fingerprints, diagnostics, and worker attempts in the separate journal database. It never owns continuation records.
- Keep `PreCompact` proposal-only; `SessionStart(source=compact)` injects active context plus the required proposal decision. This matches Codex’s supported compaction continuation hook sequence. [Codex Hooks](https://learn.chatgpt.com/zh-Hans/docs/hooks)

## Validation

- Test generated protocol schemas, strict version/digest handshake, and MCP schemas derived from the registry.
- Test immutable payload/directory COW, predecessor traversal, frozen forks, cursor repair, terminal invariants, and current-head versus historical search.
- Test transactional journal/head consistency, duplicate command receipts, delayed compact/subagent branch proposals, candidate selection, and replacement-record acceptance.
- Test hook replay, daemon launch races, stale endpoint recovery, and compact failure paths without invoking a real Codex worker.
- Build the bundled runtime, validate the marketplace plugin layout, and manually exercise root → detour → fork → stale proposal → selected candidate/replacement flow.

## Defaults

- Node 22+, strict ESM TypeScript, MCP SDK, Zod, and `node:sqlite`.
- SQLite primary keys identify immutable objects; hashes and content-addressing are deferred.
- Directory metadata uses persistent ordered directory records, not a balanced B-tree engine.
- Only predecessor lineage is first-class within payload records; external references remain schema-validated record content.
