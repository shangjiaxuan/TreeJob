export type SqlTable = {
  name: string;
  create: string;
  indexes?: readonly string[];
};

export const tables: readonly SqlTable[] = [
  {
    name: "workspaces_v3",
    create: "CREATE TABLE IF NOT EXISTS workspaces_v3(" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, canonical_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)",
  },
  {
    name: "nodes_v3",
    create: "CREATE TABLE IF NOT EXISTS nodes_v3(" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL)",
  },
  {
    name: "payload_revisions_v3",
    create: "CREATE TABLE IF NOT EXISTS payload_revisions_v3(" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL, predecessor_id INTEGER, version INTEGER NOT NULL, " +
      "kind TEXT NOT NULL, title TEXT NOT NULL, objective TEXT NOT NULL, rationale TEXT NOT NULL, current_state TEXT NOT NULL, " +
      "open_questions_json TEXT NOT NULL, return_condition TEXT NOT NULL, refs_json TEXT NOT NULL, metadata_json TEXT NOT NULL, " +
      "status TEXT NOT NULL, created_at TEXT NOT NULL)",
    indexes: ["CREATE INDEX IF NOT EXISTS payload_node_v3 ON payload_revisions_v3(node_id, version)"],
  },
  {
    name: "directory_revisions_v3",
    create: "CREATE TABLE IF NOT EXISTS directory_revisions_v3(" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL, predecessor_id INTEGER, version INTEGER NOT NULL, created_at TEXT NOT NULL)",
    indexes: ["CREATE INDEX IF NOT EXISTS directory_node_v3 ON directory_revisions_v3(node_id, version)"],
  },
  {
    name: "entries_v3",
    create: "CREATE TABLE IF NOT EXISTS entries_v3(" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL, created_at TEXT NOT NULL)",
  },
  {
    name: "entry_revisions_v3",
    create: "CREATE TABLE IF NOT EXISTS entry_revisions_v3(" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER NOT NULL, predecessor_id INTEGER, version INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)",
    indexes: ["CREATE INDEX IF NOT EXISTS entry_revision_entry_v3 ON entry_revisions_v3(entry_id, version)"],
  },
  {
    name: "node_revisions_v3",
    create: "CREATE TABLE IF NOT EXISTS node_revisions_v3(" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, node_id INTEGER NOT NULL, predecessor_id INTEGER, payload_revision_id INTEGER NOT NULL, " +
      "directory_revision_id INTEGER NOT NULL, created_at TEXT NOT NULL)",
    indexes: ["CREATE INDEX IF NOT EXISTS node_revision_node_v3 ON node_revisions_v3(node_id, id)"],
  },
  {
    name: "directory_memberships_v3",
    create: "CREATE TABLE IF NOT EXISTS directory_memberships_v3(" +
      "directory_revision_id INTEGER NOT NULL, position INTEGER NOT NULL, entry_revision_id INTEGER NOT NULL, child_node_revision_id INTEGER NOT NULL, " +
      "PRIMARY KEY(directory_revision_id, position))",
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS directory_entry_identity_v3 ON directory_memberships_v3(directory_revision_id, entry_revision_id)",
      "CREATE INDEX IF NOT EXISTS directory_member_entry_v3 ON directory_memberships_v3(entry_revision_id)",
    ],
  },
  {
    name: "snapshots_v3",
    create: "CREATE TABLE IF NOT EXISTS snapshots_v3(" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, root_node_revision_id INTEGER NOT NULL, parent_snapshot_id INTEGER, created_at TEXT NOT NULL)",
  },
  {
    name: "sessions_v3",
    create: "CREATE TABLE IF NOT EXISTS sessions_v3(" +
      "id TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, head_snapshot_id INTEGER NOT NULL, parent_session_id TEXT, created_at TEXT NOT NULL)",
  },
  {
    name: "cursors_v3",
    create: "CREATE TABLE IF NOT EXISTS cursors_v3(" +
      "session_id TEXT PRIMARY KEY, snapshot_id INTEGER NOT NULL, entry_path_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
  },
  {
    name: "proposals_v3",
    create: "CREATE TABLE IF NOT EXISTS proposals_v3(" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source_session_id TEXT, source_snapshot_id INTEGER NOT NULL, " +
      "target_node_id INTEGER NOT NULL, target_node_revision_id INTEGER NOT NULL, patch_json TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, " +
      "created_at TEXT NOT NULL, decided_at TEXT)",
  },
  {
    name: "journal_v3",
    create: "CREATE TABLE IF NOT EXISTS journal_v3(" +
      "sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, operation TEXT NOT NULL, previous_snapshot_id INTEGER, " +
      "next_snapshot_id INTEGER, cursor_entry_path_json TEXT NOT NULL, idempotency_key TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)",
    indexes: ["CREATE INDEX IF NOT EXISTS journal_session_v3 ON journal_v3(session_id, sequence)"],
  },
  {
    name: "receipts_v3",
    create: "CREATE TABLE IF NOT EXISTS receipts_v3(" +
      "session_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL, " +
      "PRIMARY KEY(session_id, idempotency_key))",
  },
];

export function migrationSql(): string[] {
  return [
    "PRAGMA journal_mode=WAL",
    "PRAGMA foreign_keys=ON",
    "PRAGMA busy_timeout=5000",
    ...tables.flatMap((table) => [table.create, ...(table.indexes ?? [])]),
    "PRAGMA user_version=3",
  ];
}
