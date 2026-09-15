export type SqlTable = {
  name: string;
  create: string;
  indexes?: readonly string[];
};

/**
 * v9 stores physical records separately from the shared-branch references
 * that make them authoritative. Session overlays and mailboxes are separate
 * collaboration layers; events remain diagnostics only.
 */
export const tables: readonly SqlTable[] = [
  {
    name: "inodes_v9",
    create: "CREATE TABLE IF NOT EXISTS inodes_v9(id INTEGER PRIMARY KEY AUTOINCREMENT,owner_user_id TEXT NOT NULL,group_id TEXT,content_access INTEGER NOT NULL,topology_access INTEGER NOT NULL,created_at TEXT NOT NULL)",
  },
  {
    name: "links_v9",
    create: "CREATE TABLE IF NOT EXISTS links_v9(id INTEGER PRIMARY KEY AUTOINCREMENT,child_inode_id INTEGER NOT NULL,created_at TEXT NOT NULL)",
    indexes: ["CREATE INDEX IF NOT EXISTS links_child_v9 ON links_v9(child_inode_id)"],
  },
  {
    name: "payload_records_v9",
    create: "CREATE TABLE IF NOT EXISTS payload_records_v9(id INTEGER PRIMARY KEY AUTOINCREMENT,work_json TEXT NOT NULL,created_at TEXT NOT NULL)",
  },
  {
    name: "node_records_v9",
    create: "CREATE TABLE IF NOT EXISTS node_records_v9(id INTEGER PRIMARY KEY AUTOINCREMENT,inode_id INTEGER NOT NULL,payload_record_id INTEGER NOT NULL,created_at TEXT NOT NULL)",
    indexes: ["CREATE INDEX IF NOT EXISTS node_records_inode_v9 ON node_records_v9(inode_id)"],
  },
  {
    name: "link_records_v9",
    create: "CREATE TABLE IF NOT EXISTS link_records_v9(id INTEGER PRIMARY KEY AUTOINCREMENT,link_id INTEGER NOT NULL,parent_inode_id INTEGER NOT NULL,name TEXT NOT NULL,created_at TEXT NOT NULL)",
    indexes: ["CREATE INDEX IF NOT EXISTS link_records_link_v9 ON link_records_v9(link_id)"],
  },
  {
    name: "filesystems_v9",
    create: "CREATE TABLE IF NOT EXISTS filesystems_v9(id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_path TEXT NOT NULL UNIQUE,root_inode_id INTEGER NOT NULL,main_branch_id INTEGER,created_at TEXT NOT NULL)",
  },
  {
    name: "branches_v9",
    create: "CREATE TABLE IF NOT EXISTS branches_v9(id INTEGER PRIMARY KEY AUTOINCREMENT,filesystem_id INTEGER NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,head_revision INTEGER NOT NULL,head_revision_created_at TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(filesystem_id,name))",
  },
  {
    name: "sessions_v9",
    create: "CREATE TABLE IF NOT EXISTS sessions_v9(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,groups_json TEXT NOT NULL,metadata_json TEXT NOT NULL,filesystem_id INTEGER,current_branch_id INTEGER,cursor_link_path_json TEXT NOT NULL,overlay_head_revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)",
  },
  {
    name: "branch_revisions_v9",
    create: "CREATE TABLE IF NOT EXISTS branch_revisions_v9(branch_id INTEGER NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(branch_id,revision)) WITHOUT ROWID",
  },
  {
    name: "branch_spans_v9",
    create: "CREATE TABLE IF NOT EXISTS branch_spans_v9(branch_id INTEGER NOT NULL,first_revision INTEGER NOT NULL,source_branch_id INTEGER,source_revision INTEGER,PRIMARY KEY(branch_id,first_revision)) WITHOUT ROWID",
  },
  {
    name: "published_node_refs_v9",
    create: "CREATE TABLE IF NOT EXISTS published_node_refs_v9(branch_id INTEGER NOT NULL,inode_id INTEGER NOT NULL,revision INTEGER NOT NULL,record_id INTEGER NOT NULL,PRIMARY KEY(branch_id,inode_id,revision)) WITHOUT ROWID",
  },
  {
    name: "published_link_refs_v9",
    create: "CREATE TABLE IF NOT EXISTS published_link_refs_v9(branch_id INTEGER NOT NULL,link_id INTEGER NOT NULL,revision INTEGER NOT NULL,record_id INTEGER NOT NULL,parent_inode_id INTEGER NOT NULL,previous_parent_inode_id INTEGER,PRIMARY KEY(branch_id,link_id,revision)) WITHOUT ROWID",
    indexes: [
      "CREATE INDEX IF NOT EXISTS published_link_parent_v9 ON published_link_refs_v9(branch_id,parent_inode_id,revision DESC,link_id)",
      "CREATE INDEX IF NOT EXISTS published_link_previous_parent_v9 ON published_link_refs_v9(branch_id,previous_parent_inode_id,revision DESC,link_id)",
    ],
  },
  {
    name: "session_overlays_v9",
    create: "CREATE TABLE IF NOT EXISTS session_overlays_v9(session_id TEXT NOT NULL,subject_kind TEXT NOT NULL,subject_id INTEGER NOT NULL,overlay_revision INTEGER NOT NULL,base_branch_id INTEGER NOT NULL,base_branch_revision INTEGER NOT NULL,base_record_id INTEGER NOT NULL,candidate_record_id INTEGER NOT NULL,parent_inode_id INTEGER,created_at TEXT NOT NULL,PRIMARY KEY(session_id,subject_kind,subject_id,overlay_revision)) WITHOUT ROWID",
    indexes: [
      "CREATE INDEX IF NOT EXISTS overlay_latest_v9 ON session_overlays_v9(session_id,subject_kind,subject_id,overlay_revision DESC)",
      "CREATE INDEX IF NOT EXISTS overlay_parent_v9 ON session_overlays_v9(session_id,subject_kind,parent_inode_id,overlay_revision DESC)",
    ],
  },
  {
    name: "mailbox_v9",
    create: "CREATE TABLE IF NOT EXISTS mailbox_v9(authority_inode_id INTEGER NOT NULL,subject_kind TEXT NOT NULL,subject_id INTEGER NOT NULL,author_session_id TEXT NOT NULL,published_overlay_revision INTEGER NOT NULL,base_branch_id INTEGER NOT NULL,base_branch_revision INTEGER NOT NULL,base_record_id INTEGER NOT NULL,candidate_record_id INTEGER NOT NULL,published_at TEXT NOT NULL,PRIMARY KEY(authority_inode_id,subject_kind,subject_id,author_session_id)) WITHOUT ROWID",
  },
  {
    name: "session_events_v9",
    create: "CREATE TABLE IF NOT EXISTS session_events_v9(sequence INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,branch_id INTEGER,revision INTEGER,event_json TEXT NOT NULL)",
  },
  {
    name: "proposals_v9",
    create: "CREATE TABLE IF NOT EXISTS proposals_v9(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,source_session_id TEXT,source_revision INTEGER NOT NULL,target_node_id INTEGER NOT NULL,base_record_id INTEGER NOT NULL,patch_json TEXT,kind TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,decided_at TEXT)",
  },
  {
    name: "receipts_v9",
    create: "CREATE TABLE IF NOT EXISTS receipts_v9(session_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(session_id,idempotency_key)) WITHOUT ROWID",
  },
];

export function migrationSql(): string[] {
  return [
    "PRAGMA journal_mode=WAL",
    "PRAGMA foreign_keys=ON",
    "PRAGMA busy_timeout=5000",
    ...tables.flatMap((table) => [table.create, ...(table.indexes ?? [])]),
    "PRAGMA user_version=9",
  ];
}
