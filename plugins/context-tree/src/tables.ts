/** Runtime SQLite descriptors for the v2 integer-key snapshot store. */
export type SqlTable = {
  name: string;
  create: string;
  indexes?: readonly string[];
};

export const tables: readonly SqlTable[] = [
  {
    name: "workspaces_v2",
    create: "CREATE TABLE IF NOT EXISTS workspaces_v2(" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "canonical_path TEXT NOT NULL UNIQUE, " +
      "created_at TEXT NOT NULL" +
      ")",
  },
  {
    name: "payload_inodes_v2",
    create: "CREATE TABLE IF NOT EXISTS payload_inodes_v2(" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "predecessor_id INTEGER, " +
      "history_version INTEGER NOT NULL, " +
      "kind TEXT NOT NULL, " +
      "title TEXT NOT NULL, " +
      "objective TEXT NOT NULL, " +
      "rationale TEXT NOT NULL, " +
      "current_state TEXT NOT NULL, " +
      "open_questions_json TEXT NOT NULL, " +
      "return_condition TEXT NOT NULL, " +
      "refs_json TEXT NOT NULL, " +
      "metadata_json TEXT NOT NULL, " +
      "status TEXT NOT NULL, " +
      "created_at TEXT NOT NULL" +
      ")",
    indexes: [
      "CREATE INDEX IF NOT EXISTS payload_predecessor_v2 " +
        "ON payload_inodes_v2(predecessor_id)",
      "CREATE INDEX IF NOT EXISTS payload_search_v2 " +
        "ON payload_inodes_v2(title, objective, current_state)",
    ],
  },
  {
    name: "directory_inodes_v2",
    create: "CREATE TABLE IF NOT EXISTS directory_inodes_v2(" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "predecessor_id INTEGER, " +
      "history_version INTEGER NOT NULL, " +
      "payload_id INTEGER NOT NULL, " +
      "entries_json TEXT NOT NULL, " +
      "created_at TEXT NOT NULL" +
      ")",
    indexes: [
      "CREATE INDEX IF NOT EXISTS directory_payload_v2 " +
        "ON directory_inodes_v2(payload_id)",
      "CREATE INDEX IF NOT EXISTS directory_predecessor_v2 " +
        "ON directory_inodes_v2(predecessor_id)",
    ],
  },
  {
    name: "snapshots_v2",
    create: "CREATE TABLE IF NOT EXISTS snapshots_v2(" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "root_directory_id INTEGER NOT NULL, " +
      "parent_snapshot_id INTEGER, " +
      "created_at TEXT NOT NULL" +
      ")",
  },
  {
    name: "sessions_v2",
    create: "CREATE TABLE IF NOT EXISTS sessions_v2(" +
      "id TEXT PRIMARY KEY, " +
      "workspace_id INTEGER NOT NULL, " +
      "head_snapshot_id INTEGER NOT NULL, " +
      "parent_session_id TEXT, " +
      "created_at TEXT NOT NULL" +
      ")",
  },
  {
    name: "cursors_v2",
    create: "CREATE TABLE IF NOT EXISTS cursors_v2(" +
      "session_id TEXT PRIMARY KEY, " +
      "snapshot_id INTEGER NOT NULL, " +
      "inode_path_json TEXT NOT NULL, " +
      "updated_at TEXT NOT NULL" +
      ")",
  },
  {
    name: "journal_v2",
    create: "CREATE TABLE IF NOT EXISTS journal_v2(" +
      "sequence INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "session_id TEXT NOT NULL, " +
      "operation TEXT NOT NULL, " +
      "previous_snapshot_id INTEGER, " +
      "next_snapshot_id INTEGER, " +
      "cursor_path_json TEXT, " +
      "receipt_key TEXT, " +
      "payload_json TEXT NOT NULL, " +
      "created_at TEXT NOT NULL" +
      ")",
    indexes: [
      "CREATE INDEX IF NOT EXISTS journal_session_v2 " +
        "ON journal_v2(session_id, sequence)",
    ],
  },
  {
    name: "receipts_v2",
    create: "CREATE TABLE IF NOT EXISTS receipts_v2(" +
      "session_id TEXT NOT NULL, " +
      "command_id TEXT NOT NULL, " +
      "result_json TEXT NOT NULL, " +
      "created_at TEXT NOT NULL, " +
      "PRIMARY KEY(session_id, command_id)" +
      ")",
  },
  {
    name: "proposals_v2",
    create: "CREATE TABLE IF NOT EXISTS proposals_v2(" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "session_id TEXT NOT NULL, " +
      "source_session_id TEXT, " +
      "source_snapshot_id INTEGER NOT NULL, " +
      "target_inode_id INTEGER NOT NULL, " +
      "candidate_inode_id INTEGER, " +
      "patch_json TEXT, " +
      "kind TEXT NOT NULL, " +
      "status TEXT NOT NULL, " +
      "created_at TEXT NOT NULL, " +
      "decided_at TEXT" +
      ")",
  },
];

export function migrationSql(): string[] {
  return [
    "PRAGMA journal_mode=WAL",
    "PRAGMA foreign_keys=ON",
    "PRAGMA busy_timeout=5000",
    ...tables.flatMap((table) => [
      table.create,
      ...(table.indexes ?? []),
    ]),
    "PRAGMA user_version=2",
  ];
}
