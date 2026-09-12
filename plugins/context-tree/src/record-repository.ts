import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { dataDir } from "./rpc.js";
import {
  IdSchema,
  JsonSchema,
  ProposalKindSchema,
  ProposalStatusSchema,
  ReferenceSchema,
  StatusSchema,
  WorkFieldsSchema,
  WorkPatchSchema,
  type Id,
  type JsonValue,
  type ProposalKind,
  type ProposalStatus,
  type RecordStatus,
  type Reference,
  type WorkFields,
  type WorkPatch,
} from "./schema.js";
import { migrationSql } from "./tables.js";

export type Workspace = { id: Id; canonicalPath: string; createdAt: string };
export type Session = {
  id: string;
  workspaceId: Id;
  headSnapshotId: Id;
  parentSessionId: string | null;
  createdAt: string;
};
export type Cursor = {
  sessionId: string;
  snapshotId: Id;
  entryPath: Id[];
  updatedAt: string;
};
export type NodeRevision = {
  id: Id;
  nodeId: Id;
  predecessorId: Id | null;
  payloadRevisionId: Id;
  directoryRevisionId: Id;
  createdAt: string;
};
export type PayloadRevision = WorkFields & {
  id: Id;
  nodeId: Id;
  predecessorId: Id | null;
  version: number;
  createdAt: string;
};
export type DirectoryRevision = {
  id: Id;
  nodeId: Id;
  predecessorId: Id | null;
  version: number;
  createdAt: string;
};
export type EntryRevision = {
  id: Id;
  entryId: Id;
  predecessorId: Id | null;
  version: number;
  name: string;
  createdAt: string;
};
export type Membership = {
  position: number;
  entryRevisionId: Id;
  childNodeRevisionId: Id;
};
export type Snapshot = {
  id: Id;
  rootNodeRevisionId: Id;
  parentSnapshotId: Id | null;
  createdAt: string;
};
export type Proposal = {
  id: Id;
  sessionId: string;
  sourceSessionId: string | null;
  sourceSnapshotId: Id;
  targetNodeId: Id;
  targetNodeRevisionId: Id;
  patch: WorkPatch | null;
  kind: ProposalKind;
  status: ProposalStatus;
  createdAt: string;
  decidedAt: string | null;
};

export type NewProposal = Omit<Proposal, "id">;
export type JournalEntry = {
  sessionId: string;
  operation: string;
  previousSnapshotId: Id | null;
  nextSnapshotId: Id | null;
  cursorEntryPath: Id[];
  idempotencyKey: string | null;
  payload: JsonValue;
};

export class RepositoryError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invariant",
    message: string,
  ) {
    super(message);
  }
}

type SqlValue = string | number | null;
const RowSchema = z.record(z.string(), z.unknown());
type Row = z.infer<typeof RowSchema>;

export interface RecordRepository {
  transaction<T>(work: () => T): T;
  findWorkspace(canonicalPath: string): Workspace | null;
  insertWorkspace(canonicalPath: string): Workspace;
  getWorkspace(id: Id): Workspace;
  getSession(id: string): Session;
  findSession(id: string): Session | null;
  insertSession(session: Session): void;
  updateSessionHead(sessionId: string, snapshotId: Id): void;
  getCursor(sessionId: string): Cursor;
  saveCursor(cursor: Cursor): void;
  createNode(): Id;
  createEntry(nodeId: Id): Id;
  getPayloadRevision(id: Id): PayloadRevision;
  insertPayloadRevision(
    nodeId: Id,
    predecessor: PayloadRevision | null,
    fields: WorkFields,
  ): PayloadRevision;
  getDirectoryRevision(id: Id): DirectoryRevision;
  insertDirectoryRevision(
    nodeId: Id,
    predecessor: DirectoryRevision | null,
    memberships: Membership[],
  ): DirectoryRevision;
  listMemberships(directoryRevisionId: Id): Membership[];
  getEntryRevision(id: Id): EntryRevision;
  insertEntryRevision(
    entryId: Id,
    predecessor: EntryRevision | null,
    name: string,
  ): EntryRevision;
  getNodeRevision(id: Id): NodeRevision;
  insertNodeRevision(
    nodeId: Id,
    predecessor: NodeRevision | null,
    payloadRevisionId: Id,
    directoryRevisionId: Id,
  ): NodeRevision;
  getSnapshot(id: Id): Snapshot;
  insertSnapshot(rootNodeRevisionId: Id, parentSnapshotId: Id | null): Snapshot;
  insertProposal(proposal: NewProposal): Proposal;
  listPendingProposals(sessionId: string): Proposal[];
  getPendingProposal(id: Id, sessionId: string): Proposal;
  updateProposalStatus(id: Id, status: ProposalStatus): void;
  findReceipt(sessionId: string, key: string): JsonValue | null;
  saveReceipt(sessionId: string, key: string, result: unknown): void;
  appendJournal(entry: JournalEntry): void;
  listSessionHeadSnapshotIds(workspaceId: Id | null): Id[];
  listHistoricalSnapshotRootRevisionIds(workspaceId: Id | null): Id[];
}

export class SqliteRecordRepository implements RecordRepository {
  private readonly db: DatabaseSync;

  constructor(file = dataDir() + "/context-tree-v3.sqlite") {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);

    for (const statement of migrationSql()) {
      this.db.exec(statement);
    }
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");

    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  findWorkspace(canonicalPath: string): Workspace | null {
    const row = this.one("SELECT * FROM workspaces_v3 WHERE canonical_path=?", canonicalPath);
    return row ? this.workspace(row) : null;
  }

  insertWorkspace(canonicalPath: string): Workspace {
    const id = this.insert(
      "INSERT INTO workspaces_v3(canonical_path,created_at) VALUES(?,?)",
      canonicalPath,
      this.timestamp(),
    );
    return this.getWorkspace(id);
  }

  getWorkspace(id: Id): Workspace {
    const row = this.one("SELECT * FROM workspaces_v3 WHERE id=?", id);
    if (!row) throw new RepositoryError("not_found", "workspace not found");
    return this.workspace(row);
  }

  getSession(id: string): Session {
    const session = this.findSession(id);
    if (!session) throw new RepositoryError("not_found", "session not found: " + id);
    return session;
  }

  findSession(id: string): Session | null {
    const row = this.one("SELECT * FROM sessions_v3 WHERE id=?", id);
    return row ? this.session(row) : null;
  }

  insertSession(session: Session): void {
    this.db.prepare(
      "INSERT INTO sessions_v3 VALUES(?,?,?,?,?)",
    ).run(
      session.id,
      session.workspaceId,
      session.headSnapshotId,
      session.parentSessionId,
      session.createdAt,
    );
  }

  updateSessionHead(sessionId: string, snapshotId: Id): void {
    this.db.prepare("UPDATE sessions_v3 SET head_snapshot_id=? WHERE id=?")
      .run(snapshotId, sessionId);
  }

  getCursor(sessionId: string): Cursor {
    const row = this.one("SELECT * FROM cursors_v3 WHERE session_id=?", sessionId);
    if (!row) throw new RepositoryError("not_found", "cursor not found");
    return {
      sessionId: String(row.session_id),
      snapshotId: this.id(row.snapshot_id),
      entryPath: this.json(z.array(IdSchema), row.entry_path_json),
      updatedAt: String(row.updated_at),
    };
  }

  saveCursor(cursor: Cursor): void {
    this.db.prepare(
      "INSERT INTO cursors_v3 VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET " +
        "snapshot_id=excluded.snapshot_id,entry_path_json=excluded.entry_path_json,updated_at=excluded.updated_at",
    ).run(cursor.sessionId, cursor.snapshotId, JSON.stringify(cursor.entryPath), cursor.updatedAt);
  }

  createNode(): Id {
    return this.insert("INSERT INTO nodes_v3(created_at) VALUES(?)", this.timestamp());
  }

  createEntry(nodeId: Id): Id {
    return this.insert("INSERT INTO entries_v3(node_id,created_at) VALUES(?,?)", nodeId, this.timestamp());
  }

  getPayloadRevision(id: Id): PayloadRevision {
    const row = this.one("SELECT * FROM payload_revisions_v3 WHERE id=?", id);
    if (!row) throw new RepositoryError("not_found", "payload revision not found");
    const fields = WorkFieldsSchema.parse({
      kind: row.kind,
      title: row.title,
      objective: row.objective,
      rationale: row.rationale,
      currentState: row.current_state,
      openQuestions: this.json(z.array(z.string()), row.open_questions_json),
      returnCondition: row.return_condition,
      refs: this.json(z.array(ReferenceSchema), row.refs_json),
      metadata: this.json(z.record(z.string(), JsonSchema), row.metadata_json),
      status: StatusSchema.parse(row.status),
    });

    return {
      id: this.id(row.id),
      nodeId: this.id(row.node_id),
      predecessorId: row.predecessor_id === null ? null : this.id(row.predecessor_id),
      version: Number(row.version),
      createdAt: String(row.created_at),
      ...fields,
    };
  }

  insertPayloadRevision(nodeId: Id, predecessor: PayloadRevision | null, fields: WorkFields): PayloadRevision {
    const id = this.insert(
      "INSERT INTO payload_revisions_v3(node_id,predecessor_id,version,kind,title,objective,rationale,current_state," +
        "open_questions_json,return_condition,refs_json,metadata_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      nodeId,
      predecessor === null ? null : predecessor.id,
      predecessor ? predecessor.version + 1 : 0,
      fields.kind,
      fields.title,
      fields.objective,
      fields.rationale,
      fields.currentState,
      JSON.stringify(fields.openQuestions),
      fields.returnCondition,
      JSON.stringify(fields.refs),
      JSON.stringify(fields.metadata),
      fields.status,
      this.timestamp(),
    );
    return this.getPayloadRevision(id);
  }

  getDirectoryRevision(id: Id): DirectoryRevision {
    const row = this.one("SELECT * FROM directory_revisions_v3 WHERE id=?", id);
    if (!row) throw new RepositoryError("not_found", "directory revision not found");
    return {
      id: this.id(row.id),
      nodeId: this.id(row.node_id),
      predecessorId: row.predecessor_id === null ? null : this.id(row.predecessor_id),
      version: Number(row.version),
      createdAt: String(row.created_at),
    };
  }

  insertDirectoryRevision(nodeId: Id, predecessor: DirectoryRevision | null, memberships: Membership[]): DirectoryRevision {
    const id = this.insert(
      "INSERT INTO directory_revisions_v3(node_id,predecessor_id,version,created_at) VALUES(?,?,?,?)",
      nodeId,
      predecessor === null ? null : predecessor.id,
      predecessor ? predecessor.version + 1 : 0,
      this.timestamp(),
    );

    const statement = this.db.prepare(
      "INSERT INTO directory_memberships_v3(directory_revision_id,position,entry_revision_id,child_node_revision_id) VALUES(?,?,?,?)",
    );
    memberships.forEach((membership, position) => {
      statement.run(id, position, membership.entryRevisionId, membership.childNodeRevisionId);
    });
    return this.getDirectoryRevision(id);
  }

  listMemberships(directoryRevisionId: Id): Membership[] {
    return this.all(
      "SELECT * FROM directory_memberships_v3 WHERE directory_revision_id=? ORDER BY position",
      directoryRevisionId,
    ).map((row) => ({
      position: Number(row.position),
      entryRevisionId: this.id(row.entry_revision_id),
      childNodeRevisionId: this.id(row.child_node_revision_id),
    }));
  }

  getEntryRevision(id: Id): EntryRevision {
    const row = this.one("SELECT * FROM entry_revisions_v3 WHERE id=?", id);
    if (!row) throw new RepositoryError("not_found", "entry revision not found");
    return {
      id: this.id(row.id),
      entryId: this.id(row.entry_id),
      predecessorId: row.predecessor_id === null ? null : this.id(row.predecessor_id),
      version: Number(row.version),
      name: String(row.name),
      createdAt: String(row.created_at),
    };
  }

  insertEntryRevision(entryId: Id, predecessor: EntryRevision | null, name: string): EntryRevision {
    const id = this.insert(
      "INSERT INTO entry_revisions_v3(entry_id,predecessor_id,version,name,created_at) VALUES(?,?,?,?,?)",
      entryId,
      predecessor === null ? null : predecessor.id,
      predecessor ? predecessor.version + 1 : 0,
      name,
      this.timestamp(),
    );
    return this.getEntryRevision(id);
  }

  getNodeRevision(id: Id): NodeRevision {
    const row = this.one("SELECT * FROM node_revisions_v3 WHERE id=?", id);
    if (!row) throw new RepositoryError("not_found", "node revision not found");
    return {
      id: this.id(row.id),
      nodeId: this.id(row.node_id),
      predecessorId: row.predecessor_id === null ? null : this.id(row.predecessor_id),
      payloadRevisionId: this.id(row.payload_revision_id),
      directoryRevisionId: this.id(row.directory_revision_id),
      createdAt: String(row.created_at),
    };
  }

  insertNodeRevision(
    nodeId: Id,
    predecessor: NodeRevision | null,
    payloadRevisionId: Id,
    directoryRevisionId: Id,
  ): NodeRevision {
    const id = this.insert(
      "INSERT INTO node_revisions_v3(node_id,predecessor_id,payload_revision_id,directory_revision_id,created_at) VALUES(?,?,?,?,?)",
      nodeId,
      predecessor === null ? null : predecessor.id,
      payloadRevisionId,
      directoryRevisionId,
      this.timestamp(),
    );
    return this.getNodeRevision(id);
  }

  getSnapshot(id: Id): Snapshot {
    const row = this.one("SELECT * FROM snapshots_v3 WHERE id=?", id);
    if (!row) throw new RepositoryError("not_found", "snapshot not found");
    return {
      id: this.id(row.id),
      rootNodeRevisionId: this.id(row.root_node_revision_id),
      parentSnapshotId: row.parent_snapshot_id === null ? null : this.id(row.parent_snapshot_id),
      createdAt: String(row.created_at),
    };
  }

  insertSnapshot(rootNodeRevisionId: Id, parentSnapshotId: Id | null): Snapshot {
    const id = this.insert(
      "INSERT INTO snapshots_v3(root_node_revision_id,parent_snapshot_id,created_at) VALUES(?,?,?)",
      rootNodeRevisionId,
      parentSnapshotId,
      this.timestamp(),
    );
    return this.getSnapshot(id);
  }

  insertProposal(proposal: NewProposal): Proposal {
    const id = this.insert(
      "INSERT INTO proposals_v3(session_id,source_session_id,source_snapshot_id,target_node_id,target_node_revision_id," +
        "patch_json,kind,status,created_at,decided_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      proposal.sessionId,
      proposal.sourceSessionId,
      proposal.sourceSnapshotId,
      proposal.targetNodeId,
      proposal.targetNodeRevisionId,
      proposal.patch ? JSON.stringify(proposal.patch) : null,
      proposal.kind,
      proposal.status,
      proposal.createdAt,
      proposal.decidedAt,
    );
    return this.getProposal(id);
  }

  listPendingProposals(sessionId: string): Proposal[] {
    return this.all(
      "SELECT * FROM proposals_v3 WHERE session_id=? AND status='pending' ORDER BY created_at",
      sessionId,
    ).map((row) => this.proposal(row));
  }

  getPendingProposal(id: Id, sessionId: string): Proposal {
    const row = this.one(
      "SELECT * FROM proposals_v3 WHERE id=? AND session_id=? AND status='pending'",
      id,
      sessionId,
    );
    if (!row) throw new RepositoryError("not_found", "pending proposal not found");
    return this.proposal(row);
  }

  updateProposalStatus(id: Id, status: ProposalStatus): void {
    this.db.prepare("UPDATE proposals_v3 SET status=?,decided_at=? WHERE id=?")
      .run(status, this.timestamp(), id);
  }

  findReceipt(sessionId: string, key: string): JsonValue | null {
    const row = this.one(
      "SELECT result_json FROM receipts_v3 WHERE session_id=? AND idempotency_key=?",
      sessionId,
      key,
    );
    return row ? JsonSchema.parse(JSON.parse(String(row.result_json))) : null;
  }

  saveReceipt(sessionId: string, key: string, result: unknown): void {
    this.db.prepare("INSERT INTO receipts_v3 VALUES(?,?,?,?)")
      .run(sessionId, key, JSON.stringify(JsonSchema.parse(result)), this.timestamp());
  }

  appendJournal(entry: JournalEntry): void {
    this.db.prepare(
      "INSERT INTO journal_v3(session_id,operation,previous_snapshot_id,next_snapshot_id,cursor_entry_path_json,idempotency_key,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      entry.sessionId,
      entry.operation,
      entry.previousSnapshotId,
      entry.nextSnapshotId,
      JSON.stringify(entry.cursorEntryPath),
      entry.idempotencyKey,
      JSON.stringify(entry.payload),
      this.timestamp(),
    );
  }

  listSessionHeadSnapshotIds(workspaceId: Id | null): Id[] {
    const query = workspaceId === null
      ? "SELECT head_snapshot_id FROM sessions_v3"
      : "SELECT head_snapshot_id FROM sessions_v3 WHERE workspace_id=?";
    const rows = workspaceId === null ? this.all(query) : this.all(query, workspaceId);
    return rows.map((row) => this.id(row.head_snapshot_id));
  }

  listHistoricalSnapshotRootRevisionIds(workspaceId: Id | null): Id[] {
    const seed = workspaceId === null
      ? "SELECT head_snapshot_id AS id FROM sessions_v3"
      : "SELECT head_snapshot_id AS id FROM sessions_v3 WHERE workspace_id=?";
    const query = "WITH RECURSIVE lineage(id) AS (" + seed + " UNION " +
      "SELECT snapshots_v3.parent_snapshot_id FROM snapshots_v3 JOIN lineage " +
      "ON snapshots_v3.id=lineage.id WHERE snapshots_v3.parent_snapshot_id IS NOT NULL) " +
      "SELECT DISTINCT snapshots_v3.root_node_revision_id FROM snapshots_v3 JOIN lineage " +
      "ON snapshots_v3.id=lineage.id";
    const rows = workspaceId === null ? this.all(query) : this.all(query, workspaceId);
    return rows.map((row) => this.id(row.root_node_revision_id));
  }

  private getProposal(id: Id): Proposal {
    const row = this.one("SELECT * FROM proposals_v3 WHERE id=?", id);
    if (!row) throw new RepositoryError("not_found", "proposal not found");
    return this.proposal(row);
  }

  private proposal(row: Row): Proposal {
    return {
      id: this.id(row.id),
      sessionId: String(row.session_id),
      sourceSessionId: row.source_session_id === null ? null : String(row.source_session_id),
      sourceSnapshotId: this.id(row.source_snapshot_id),
      targetNodeId: this.id(row.target_node_id),
      targetNodeRevisionId: this.id(row.target_node_revision_id),
      patch: row.patch_json === null ? null : WorkPatchSchema.parse(JSON.parse(String(row.patch_json))),
      kind: ProposalKindSchema.parse(row.kind),
      status: ProposalStatusSchema.parse(row.status),
      createdAt: String(row.created_at),
      decidedAt: row.decided_at === null ? null : String(row.decided_at),
    };
  }

  private workspace(row: Row): Workspace {
    return {
      id: this.id(row.id),
      canonicalPath: String(row.canonical_path),
      createdAt: String(row.created_at),
    };
  }

  private session(row: Row): Session {
    return {
      id: String(row.id),
      workspaceId: this.id(row.workspace_id),
      headSnapshotId: this.id(row.head_snapshot_id),
      parentSessionId: row.parent_session_id === null ? null : String(row.parent_session_id),
      createdAt: String(row.created_at),
    };
  }

  private one(sql: string, ...values: SqlValue[]): Row | null {
    const row = this.db.prepare(sql).get(...values);
    return row === undefined ? null : RowSchema.parse(row);
  }

  private all(sql: string, ...values: SqlValue[]): Row[] {
    return z.array(RowSchema).parse(this.db.prepare(sql).all(...values));
  }

  private insert(sql: string, ...values: SqlValue[]): Id {
    const row = this.db.prepare(sql + " RETURNING id").get(...values);
    if (!row) throw new RepositoryError("invariant", "insert did not return id");
    return this.id(RowSchema.parse(row).id);
  }

  private id(value: unknown): Id {
    return IdSchema.parse(Number(value));
  }

  private json<T>(schema: z.ZodType<T>, value: unknown): T {
    return schema.parse(JSON.parse(String(value)));
  }

  private timestamp(): string {
    return new Date().toISOString();
  }
}
