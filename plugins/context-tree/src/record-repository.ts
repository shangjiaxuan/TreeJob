import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { dataDir } from "./rpc.js";
import {
  CursorSchema,
  DirectoryEntrySchema,
  DirectoryInodeSchema,
  IdSchema,
  JsonSchema,
  PayloadInodeSchema,
  PayloadPatchSchema,
  ProposalSchema,
  ReferenceSchema,
  SessionStateSchema,
  SnapshotSchema,
  WorkspaceSchema,
  type Cursor,
  type DirectoryInode,
  type InodeId,
  type PayloadInode,
  type Proposal,
  type SessionState,
  type Snapshot,
  type Workspace,
} from "./schema.js";
import { migrationSql } from "./tables.js";

export type NewPayloadInode = Omit<PayloadInode, "id">;
export type NewDirectoryInode = Omit<DirectoryInode, "id">;
export type NewSnapshot = Omit<Snapshot, "id">;
export type NewProposal = Omit<Proposal, "id">;
export type NewWorkspace = Omit<Workspace, "id">;
export type { SessionState, Workspace };

export type JournalEntry = {
  sessionId: string;
  operation: string;
  previousSnapshotId: InodeId | null;
  nextSnapshotId: InodeId | null;
  cursorPath: InodeId[];
  commandId: string | undefined;
  payload: unknown;
};

type SqlArgument = string | number | null;
const SqlRowSchema = z.record(z.string(), z.unknown());
type SqlRow = z.infer<typeof SqlRowSchema>;

export interface RecordRepository {
  transaction<T>(work: () => T): T;
  findWorkspaceByPath(canonicalPath: string): Workspace | undefined;
  insertWorkspace(workspace: NewWorkspace): Workspace;
  getSession(id: string): SessionState;
  findSession(id: string): SessionState | undefined;
  insertSession(session: SessionState): void;
  updateSessionHead(sessionId: string, snapshotId: InodeId): void;
  getCursor(sessionId: string): Cursor;
  saveCursor(cursor: Cursor): void;
  getPayload(id: InodeId): PayloadInode;
  insertPayload(payload: NewPayloadInode): PayloadInode;
  getDirectory(id: InodeId): DirectoryInode;
  insertDirectory(directory: NewDirectoryInode): DirectoryInode;
  getSnapshot(id: InodeId): Snapshot;
  insertSnapshot(snapshot: NewSnapshot): Snapshot;
  getProposal(id: InodeId): Proposal;
  findPendingProposal(id: InodeId, sessionId: string): Proposal | undefined;
  insertProposal(proposal: NewProposal): Proposal;
  listPendingProposals(sessionId: string): Proposal[];
  updateProposalStatus(
    id: InodeId,
    status: "applied" | "rejected" | "discarded",
    decidedAt: string,
  ): void;
  listAllPayloadIds(): InodeId[];
  listSessionHeadSnapshotIds(workspaceId?: InodeId): InodeId[];
  findReceipt(sessionId: string, commandId: string): unknown | undefined;
  saveReceipt(sessionId: string, commandId: string, result: unknown): void;
  appendJournal(entry: JournalEntry): void;
}

export class RepositoryError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invariant",
    message: string,
  ) {
    super(message);
  }
}

export class SqliteRecordRepository implements RecordRepository {
  private readonly db: DatabaseSync;

  constructor(file = dataDir() + "/context-tree-v2.sqlite") {
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

  findWorkspaceByPath(canonicalPath: string): Workspace | undefined {
    const row = this.one(
      "SELECT * FROM workspaces_v2 WHERE canonical_path=?",
      canonicalPath,
    );

    return row ? this.workspace(row) : undefined;
  }

  insertWorkspace(workspace: NewWorkspace): Workspace {
    const id = this.insert(
      "INSERT INTO workspaces_v2(canonical_path,created_at) VALUES(?,?)",
      workspace.canonicalPath,
      workspace.createdAt,
    );

    return this.getWorkspace(id);
  }

  getSession(id: string): SessionState {
    const session = this.findSession(id);

    if (!session) {
      throw new RepositoryError("not_found", "session not found: " + id);
    }

    return session;
  }

  findSession(id: string): SessionState | undefined {
    const row = this.one("SELECT * FROM sessions_v2 WHERE id=?", id);
    return row ? this.session(row) : undefined;
  }

  insertSession(session: SessionState): void {
    this.db.prepare(
      "INSERT INTO sessions_v2 VALUES(?,?,?,?,?)",
    ).run(
      session.id,
      session.workspaceId,
      session.headSnapshotId,
      session.parentSessionId,
      session.createdAt,
    );
  }

  updateSessionHead(sessionId: string, snapshotId: InodeId): void {
    this.db.prepare(
      "UPDATE sessions_v2 SET head_snapshot_id=? WHERE id=?",
    ).run(snapshotId, sessionId);
  }

  getCursor(sessionId: string): Cursor {
    const row = this.one(
      "SELECT * FROM cursors_v2 WHERE session_id=?",
      sessionId,
    );

    if (!row) {
      throw new RepositoryError("not_found", "cursor not found: " + sessionId);
    }

    return CursorSchema.parse({
      sessionId: row.session_id,
      snapshotId: Number(row.snapshot_id),
      inodePath: this.parseJson(z.array(IdSchema).min(1), row.inode_path_json),
      updatedAt: row.updated_at,
    });
  }

  saveCursor(cursor: Cursor): void {
    this.db.prepare(
      "INSERT INTO cursors_v2 VALUES(?,?,?,?) " +
        "ON CONFLICT(session_id) DO UPDATE SET " +
        "snapshot_id=excluded.snapshot_id, " +
        "inode_path_json=excluded.inode_path_json, " +
        "updated_at=excluded.updated_at",
    ).run(
      cursor.sessionId,
      cursor.snapshotId,
      JSON.stringify(cursor.inodePath),
      cursor.updatedAt,
    );
  }

  getPayload(id: InodeId): PayloadInode {
    const row = this.one("SELECT * FROM payload_inodes_v2 WHERE id=?", id);

    if (!row) {
      throw new RepositoryError("not_found", "payload inode not found: " + id);
    }

    return PayloadInodeSchema.parse({
      id: Number(row.id),
      predecessorId: row.predecessor_id === null
        ? null
        : Number(row.predecessor_id),
      historyVersion: Number(row.history_version),
      kind: row.kind,
      title: row.title,
      objective: row.objective,
      rationale: row.rationale,
      currentState: row.current_state,
      openQuestions: this.parseJson(z.array(z.string()), row.open_questions_json),
      returnCondition: row.return_condition,
      refs: this.parseJson(z.array(ReferenceSchema), row.refs_json),
      metadata: this.parseJson(
        z.record(z.string(), JsonSchema),
        row.metadata_json,
      ),
      status: row.status,
      createdAt: row.created_at,
    });
  }

  insertPayload(payload: NewPayloadInode): PayloadInode {
    const id = this.insert(
      "INSERT INTO payload_inodes_v2(" +
        "predecessor_id,history_version,kind,title,objective,rationale," +
        "current_state,open_questions_json,return_condition,refs_json," +
        "metadata_json,status,created_at" +
        ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      payload.predecessorId,
      payload.historyVersion,
      payload.kind,
      payload.title,
      payload.objective,
      payload.rationale,
      payload.currentState,
      JSON.stringify(payload.openQuestions),
      payload.returnCondition,
      JSON.stringify(payload.refs),
      JSON.stringify(payload.metadata),
      payload.status,
      payload.createdAt,
    );

    return this.getPayload(id);
  }

  getDirectory(id: InodeId): DirectoryInode {
    const row = this.one("SELECT * FROM directory_inodes_v2 WHERE id=?", id);

    if (!row) {
      throw new RepositoryError("not_found", "directory inode not found: " + id);
    }

    return DirectoryInodeSchema.parse({
      id: Number(row.id),
      predecessorId: row.predecessor_id === null
        ? null
        : Number(row.predecessor_id),
      historyVersion: Number(row.history_version),
      payloadId: Number(row.payload_id),
      entries: this.parseJson(
        z.array(DirectoryEntrySchema),
        row.entries_json,
      ),
      createdAt: row.created_at,
    });
  }

  insertDirectory(directory: NewDirectoryInode): DirectoryInode {
    const id = this.insert(
      "INSERT INTO directory_inodes_v2(" +
        "predecessor_id,history_version,payload_id,entries_json,created_at" +
        ") VALUES(?,?,?,?,?)",
      directory.predecessorId,
      directory.historyVersion,
      directory.payloadId,
      JSON.stringify(directory.entries),
      directory.createdAt,
    );

    return this.getDirectory(id);
  }

  getSnapshot(id: InodeId): Snapshot {
    const row = this.one("SELECT * FROM snapshots_v2 WHERE id=?", id);

    if (!row) {
      throw new RepositoryError("not_found", "snapshot not found: " + id);
    }

    return SnapshotSchema.parse({
      id: Number(row.id),
      rootDirectoryId: Number(row.root_directory_id),
      parentSnapshotId: row.parent_snapshot_id === null
        ? null
        : Number(row.parent_snapshot_id),
      createdAt: row.created_at,
    });
  }

  insertSnapshot(snapshot: NewSnapshot): Snapshot {
    const id = this.insert(
      "INSERT INTO snapshots_v2(" +
        "root_directory_id,parent_snapshot_id,created_at" +
        ") VALUES(?,?,?)",
      snapshot.rootDirectoryId,
      snapshot.parentSnapshotId,
      snapshot.createdAt,
    );

    return this.getSnapshot(id);
  }

  getProposal(id: InodeId): Proposal {
    const proposal = this.findProposal(id);

    if (!proposal) {
      throw new RepositoryError("not_found", "proposal not found: " + id);
    }

    return proposal;
  }

  findPendingProposal(id: InodeId, sessionId: string): Proposal | undefined {
    const row = this.one(
      "SELECT * FROM proposals_v2 WHERE id=? AND session_id=? AND status='pending'",
      id,
      sessionId,
    );

    return row ? this.proposal(row) : undefined;
  }

  insertProposal(proposal: NewProposal): Proposal {
    const id = this.insert(
      "INSERT INTO proposals_v2(" +
        "session_id,source_session_id,source_snapshot_id,target_inode_id," +
        "candidate_inode_id,patch_json,kind,status,created_at,decided_at" +
        ") VALUES(?,?,?,?,?,?,?,?,?,?)",
      proposal.sessionId,
      proposal.sourceSessionId,
      proposal.sourceSnapshotId,
      proposal.targetInodeId,
      proposal.candidateInodeId,
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
      "SELECT * FROM proposals_v2 WHERE session_id=? AND status='pending' " +
        "ORDER BY created_at",
      sessionId,
    ).map((row) => this.proposal(row));
  }

  updateProposalStatus(
    id: InodeId,
    status: "applied" | "rejected" | "discarded",
    decidedAt: string,
  ): void {
    this.db.prepare(
      "UPDATE proposals_v2 SET status=?,decided_at=? WHERE id=?",
    ).run(status, decidedAt, id);
  }

  listAllPayloadIds(): InodeId[] {
    return this.all("SELECT id FROM payload_inodes_v2").map((row) =>
      Number(row.id),
    );
  }

  listSessionHeadSnapshotIds(workspaceId?: InodeId): InodeId[] {
    const query = workspaceId === undefined
      ? "SELECT head_snapshot_id FROM sessions_v2"
      : "SELECT head_snapshot_id FROM sessions_v2 WHERE workspace_id=?";
    const arguments_ = workspaceId === undefined ? [] : [workspaceId];

    return this.all(query, ...arguments_).map((row) =>
      Number(row.head_snapshot_id),
    );
  }

  findReceipt(sessionId: string, commandId: string): unknown | undefined {
    const row = this.one(
      "SELECT result_json FROM receipts_v2 WHERE session_id=? AND command_id=?",
      sessionId,
      commandId,
    );

    return row ? JSON.parse(String(row.result_json)) : undefined;
  }

  saveReceipt(sessionId: string, commandId: string, result: unknown): void {
    this.db.prepare(
      "INSERT INTO receipts_v2 VALUES(?,?,?,?)",
    ).run(sessionId, commandId, JSON.stringify(result), this.timestamp());
  }

  appendJournal(entry: JournalEntry): void {
    this.db.prepare(
      "INSERT INTO journal_v2(" +
        "session_id,operation,previous_snapshot_id,next_snapshot_id," +
        "cursor_path_json,receipt_key,payload_json,created_at" +
        ") VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      entry.sessionId,
      entry.operation,
      entry.previousSnapshotId,
      entry.nextSnapshotId,
      JSON.stringify(entry.cursorPath),
      entry.commandId ?? null,
      JSON.stringify(entry.payload),
      this.timestamp(),
    );
  }

  private getWorkspace(id: InodeId): Workspace {
    const row = this.one("SELECT * FROM workspaces_v2 WHERE id=?", id);

    if (!row) {
      throw new RepositoryError("not_found", "workspace not found: " + id);
    }

    return WorkspaceSchema.parse({
      id: Number(row.id),
      canonicalPath: row.canonical_path,
      createdAt: row.created_at,
    });
  }

  private workspace(row: SqlRow): Workspace {
    return WorkspaceSchema.parse({
      id: Number(row.id),
      canonicalPath: row.canonical_path,
      createdAt: row.created_at,
    });
  }

  private findProposal(id: InodeId): Proposal | undefined {
    const row = this.one("SELECT * FROM proposals_v2 WHERE id=?", id);
    return row ? this.proposal(row) : undefined;
  }

  private one(sql: string, ...arguments_: SqlArgument[]): SqlRow | undefined {
    const row = this.db.prepare(sql).get(...arguments_);
    return row === undefined ? undefined : SqlRowSchema.parse(row);
  }

  private all(sql: string, ...arguments_: SqlArgument[]): SqlRow[] {
    return z.array(SqlRowSchema).parse(
      this.db.prepare(sql).all(...arguments_),
    );
  }

  private insert(sql: string, ...arguments_: SqlArgument[]): InodeId {
    const row = this.db.prepare(sql + " RETURNING id").get(...arguments_);

    if (row === undefined) {
      throw new RepositoryError(
        "invariant",
        "autoincrement insert did not return an identifier",
      );
    }

    const returned = SqlRowSchema.parse(row);
    return IdSchema.parse(Number(returned.id));
  }

  private parseJson<T>(schema: z.ZodType<T>, raw: unknown): T {
    return schema.parse(JSON.parse(String(raw)));
  }

  private session(row: SqlRow): SessionState {
    return SessionStateSchema.parse({
      id: row.id,
      workspaceId: Number(row.workspace_id),
      headSnapshotId: Number(row.head_snapshot_id),
      parentSessionId: row.parent_session_id ?? null,
      createdAt: row.created_at,
    });
  }

  private proposal(row: SqlRow): Proposal {
    return ProposalSchema.parse({
      id: Number(row.id),
      sessionId: row.session_id,
      sourceSessionId: row.source_session_id ?? null,
      sourceSnapshotId: Number(row.source_snapshot_id),
      targetInodeId: Number(row.target_inode_id),
      candidateInodeId: row.candidate_inode_id === null
        ? null
        : Number(row.candidate_inode_id),
      patch: row.patch_json
        ? this.parseJson(PayloadPatchSchema, row.patch_json)
        : null,
      kind: row.kind,
      status: row.status,
      createdAt: row.created_at,
      decidedAt: row.decided_at ?? null,
    });
  }

  private timestamp(): string {
    return new Date().toISOString();
  }
}
