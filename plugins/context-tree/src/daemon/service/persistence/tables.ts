export type SqlTable = {
  name: string;
  create: string;
  indexes?: readonly string[];
};

/**
 * v8 stores physical records separately from the published references that
 * make them visible in a session/revision span. Events are diagnostics only.
 */
export const tables: readonly SqlTable[] = [
  {
    name: "inodes_v8",
    create: "CREATE TABLE IF NOT EXISTS inodes_v8(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL)",
  },
  {
    name: "links_v8",
    create: "CREATE TABLE IF NOT EXISTS links_v8(id INTEGER PRIMARY KEY AUTOINCREMENT,child_inode_id INTEGER NOT NULL,created_at TEXT NOT NULL)",
    indexes: ["CREATE INDEX IF NOT EXISTS links_child_v8 ON links_v8(child_inode_id)"],
  },
  {
    name: "payload_records_v8",
    create: "CREATE TABLE IF NOT EXISTS payload_records_v8(id INTEGER PRIMARY KEY AUTOINCREMENT,work_json TEXT NOT NULL,created_at TEXT NOT NULL)",
  },
  {
    name: "node_records_v8",
    create: "CREATE TABLE IF NOT EXISTS node_records_v8(id INTEGER PRIMARY KEY AUTOINCREMENT,inode_id INTEGER NOT NULL,payload_record_id INTEGER NOT NULL,created_at TEXT NOT NULL)",
    indexes: ["CREATE INDEX IF NOT EXISTS node_records_inode_v8 ON node_records_v8(inode_id)"],
  },
  {
    name: "link_records_v8",
    create: "CREATE TABLE IF NOT EXISTS link_records_v8(id INTEGER PRIMARY KEY AUTOINCREMENT,link_id INTEGER NOT NULL,parent_inode_id INTEGER NOT NULL,name TEXT NOT NULL,created_at TEXT NOT NULL)",
    indexes: ["CREATE INDEX IF NOT EXISTS link_records_link_v8 ON link_records_v8(link_id)"],
  },
  {
    name: "sessions_v8",
    create: "CREATE TABLE IF NOT EXISTS sessions_v8(id TEXT PRIMARY KEY,workspace_path TEXT NOT NULL,root_inode_id INTEGER NOT NULL,head_revision INTEGER NOT NULL,head_revision_created_at TEXT NOT NULL,cursor_link_path_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)",
    indexes: ["CREATE INDEX IF NOT EXISTS sessions_workspace_v8 ON sessions_v8(workspace_path)"],
  },
  {
    name: "session_revisions_v8",
    create: "CREATE TABLE IF NOT EXISTS session_revisions_v8(session_id TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(session_id,revision)) WITHOUT ROWID",
  },
  {
    name: "session_spans_v8",
    create: "CREATE TABLE IF NOT EXISTS session_spans_v8(session_id TEXT NOT NULL,first_revision INTEGER NOT NULL,source_session_id TEXT,source_revision INTEGER,PRIMARY KEY(session_id,first_revision)) WITHOUT ROWID",
  },
  {
    name: "published_node_refs_v8",
    create: "CREATE TABLE IF NOT EXISTS published_node_refs_v8(session_id TEXT NOT NULL,inode_id INTEGER NOT NULL,revision INTEGER NOT NULL,record_id INTEGER NOT NULL,PRIMARY KEY(session_id,inode_id,revision)) WITHOUT ROWID",
  },
  {
    name: "published_link_refs_v8",
    create: "CREATE TABLE IF NOT EXISTS published_link_refs_v8(session_id TEXT NOT NULL,link_id INTEGER NOT NULL,revision INTEGER NOT NULL,record_id INTEGER NOT NULL,parent_inode_id INTEGER NOT NULL,previous_parent_inode_id INTEGER,PRIMARY KEY(session_id,link_id,revision)) WITHOUT ROWID",
    indexes: [
      "CREATE INDEX IF NOT EXISTS published_link_parent_v8 ON published_link_refs_v8(session_id,parent_inode_id,revision DESC,link_id)",
      "CREATE INDEX IF NOT EXISTS published_link_previous_parent_v8 ON published_link_refs_v8(session_id,previous_parent_inode_id,revision DESC,link_id)",
    ],
  },
  {
    name: "session_events_v8",
    create: "CREATE TABLE IF NOT EXISTS session_events_v8(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,revision INTEGER,event_json TEXT NOT NULL)",
    indexes: ["CREATE INDEX IF NOT EXISTS events_session_v8 ON session_events_v8(session_id,sequence)"],
  },
  {
    name: "proposals_v8",
    create: "CREATE TABLE IF NOT EXISTS proposals_v8(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,source_session_id TEXT,source_revision INTEGER NOT NULL,target_node_id INTEGER NOT NULL,base_record_id INTEGER NOT NULL,patch_json TEXT,kind TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,decided_at TEXT)",
  },
  {
    name: "receipts_v8",
    create: "CREATE TABLE IF NOT EXISTS receipts_v8(session_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(session_id,idempotency_key)) WITHOUT ROWID",
  },
];

export function migrationSql(): string[] {
  return [
    "PRAGMA journal_mode=WAL",
    "PRAGMA foreign_keys=ON",
    "PRAGMA busy_timeout=5000",
    ...tables.flatMap((table) => [table.create, ...(table.indexes ?? [])]),
    "PRAGMA user_version=8",
  ];
}
