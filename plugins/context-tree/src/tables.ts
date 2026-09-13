export type SqlTable = {
  name: string;
  create: string;
  indexes?: readonly string[];
};

/**
 * v6 separates node work history from link/topology history. A session
 * revision is the immutable view coordinate; there is no snapshot overlay.
 */
export const tables: readonly SqlTable[] = [
  {
    name: "nodes_v6",
    create: "CREATE TABLE IF NOT EXISTS nodes_v6(id INTEGER PRIMARY KEY AUTOINCREMENT,created_session_id TEXT NOT NULL,created_revision INTEGER NOT NULL,created_at TEXT NOT NULL)",
  },
  {
    name: "links_v6",
    create: "CREATE TABLE IF NOT EXISTS links_v6(id INTEGER PRIMARY KEY AUTOINCREMENT,child_node_id INTEGER NOT NULL,created_session_id TEXT NOT NULL,created_revision INTEGER NOT NULL,created_at TEXT NOT NULL)",
    indexes: ["CREATE INDEX IF NOT EXISTS link_child_v6 ON links_v6(child_node_id)"],
  },
  {
    name: "node_records_v6",
    create: "CREATE TABLE IF NOT EXISTS node_records_v6(id INTEGER PRIMARY KEY AUTOINCREMENT,node_id INTEGER NOT NULL,session_id TEXT NOT NULL,revision INTEGER NOT NULL,work_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(node_id,session_id,revision))",
    indexes: ["CREATE INDEX IF NOT EXISTS node_view_v6 ON node_records_v6(node_id,session_id,revision DESC)"],
  },
  {
    name: "link_records_v6",
    create: "CREATE TABLE IF NOT EXISTS link_records_v6(id INTEGER PRIMARY KEY AUTOINCREMENT,link_id INTEGER NOT NULL,session_id TEXT NOT NULL,revision INTEGER NOT NULL,parent_node_id INTEGER NOT NULL,name TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(link_id,session_id,revision))",
    indexes: [
      "CREATE INDEX IF NOT EXISTS link_view_v6 ON link_records_v6(link_id,session_id,revision DESC)",
      "CREATE INDEX IF NOT EXISTS link_parent_v6 ON link_records_v6(parent_node_id,session_id,revision DESC)",
    ],
  },
  {
    name: "sessions_v6",
    create: "CREATE TABLE IF NOT EXISTS sessions_v6(id TEXT PRIMARY KEY,workspace_path TEXT NOT NULL,root_node_id INTEGER NOT NULL,head_revision INTEGER NOT NULL,cursor_link_path_json TEXT NOT NULL,parent_session_id TEXT,parent_session_revision INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)",
    indexes: ["CREATE INDEX IF NOT EXISTS session_workspace_v6 ON sessions_v6(workspace_path)"],
  },
  {
    name: "session_events_v6",
    create: "CREATE TABLE IF NOT EXISTS session_events_v6(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,revision INTEGER,root_node_id INTEGER,operation TEXT NOT NULL,cursor_link_path_json TEXT NOT NULL,idempotency_key TEXT,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(session_id,revision))",
    indexes: ["CREATE INDEX IF NOT EXISTS event_session_v6 ON session_events_v6(session_id,sequence)"],
  },
  {
    name: "proposals_v6",
    create: "CREATE TABLE IF NOT EXISTS proposals_v6(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,source_session_id TEXT,source_revision INTEGER NOT NULL,target_node_id INTEGER NOT NULL,base_record_id INTEGER NOT NULL,patch_json TEXT,kind TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,decided_at TEXT)",
  },
  {
    name: "receipts_v6",
    create: "CREATE TABLE IF NOT EXISTS receipts_v6(session_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(session_id,idempotency_key))",
  },
];

export function migrationSql(): string[] {
  return [
    "PRAGMA journal_mode=WAL",
    "PRAGMA foreign_keys=ON",
    "PRAGMA busy_timeout=5000",
    ...tables.flatMap((table) => [table.create, ...(table.indexes ?? [])]),
    "PRAGMA user_version=6",
  ];
}
