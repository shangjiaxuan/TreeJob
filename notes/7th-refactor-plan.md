# Context Tree — MCP-Centric Architecture Cleanup

## Summary

Make the daemon the sole Context Tree MCP service and SQLite owner. It exposes the single `command` tool through loopback stateless Streamable HTTP MCP. STDIO, shell, hooks, and browser are independent clients.

Use a clean `context-tree-v7.sqlite` cutover; leave v6 data untouched.

## Source ownership

```text
protocol/
  command contracts, schemas, parser, MCP tool definition

daemon/
  runtime/
    configuration, port binding, registry, lifecycle
  mcp/
    Streamable HTTP MCP server and controller binding
  service/
    application/
      controller, transactions, receipts, journal orchestration
    domain/
      continuation model and tree semantics
    persistence/
      SQLite tables, codecs, repository
  entrypoint.ts

clients/
  stdio-bridge/
  shell/
  hooks/
  browser/
```

- `daemon/service/` exclusively contains domain, persistence, and application code.
- Only `daemon/runtime/` accesses the endpoint registry.
- `protocol/` contains no SQLite, daemon lifecycle, registry, or client code.
- Each client references `protocol/` for the typed command envelope, tool name, and result schemas, but never imports daemon/service code.
- Remove custom socket JSON-RPC, `hello`, RPC schemas, digest, and `rpc.ts`. MCP initialization is the only protocol handshake.

## MCP endpoint and clients

- Add `CONTEXT_TREE_MCP_PORT`; default to fixed port `43177`.
- Bind `127.0.0.1:<port>/mcp`.
- `CONTEXT_TREE_MCP_PORT=0` permits OS-assigned ports only for controlled/manual use; independent clients require `CONTEXT_TREE_MCP_ENDPOINT` with the exact loopback `/mcp` URL.
- `CONTEXT_TREE_MCP_ENDPOINT` overrides the port setting and is rejected unless it is loopback HTTP and ends in `/mcp`.
- The daemon registry records endpoint, PID, data-directory fingerprint, service version, and startup time; no client reads it.
- The STDIO bridge proxies MCP initialization, discovery, and tool calls without command-specific parsing.
- Shell, hooks, and browser each own their MCP connection adapter, construct `command` calls from protocol types, and validate returned results.
- Browser remains a read-only HTTP/view client; it composes public MCP commands and never exposes browser-specific daemon operations.

## Controller events and v7 persistence

- Preserve the public one-tool `command` contract and command grammar.
- Carry idempotency in MCP request `_meta`, outside public tool input. Reuse a key only across uncertain transport retries; never retry typed command errors.
- Remove all model calls to `appendEvent`. The controller creates event drafts and commits them atomically with state, receipts, and session changes.
- Store a schema-validated direct `event_json` document. Keep only sequence, `session_id`, and nullable `revision` as indexed event columns.
- Event JSON contains action, root reference, cursor path, idempotency key, details, and timestamp. Repository serialization/deserialization is its only codec.
- Create v7 tables/codecs; do not migrate or dual-read v6.

## Validation

- Test fixed-port startup, collisions, explicit dynamic endpoints, endpoint validation, stale registry recovery, startup races, and idle shutdown.
- Test direct daemon MCP calls and STDIO proxy equivalence for discovery, success, and typed failure.
- Test shell, hook, and browser clients against the configured endpoint without registry imports.
- Test direct event JSON round-trip, indexed revision lookup, receipt/event atomicity, and absence of model event persistence.
- Retain forks, link history, moves, proposals, compact hooks, historical browser, packaging, and staged plugin validation coverage.
