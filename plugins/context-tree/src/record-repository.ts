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
  WorkFieldsSchema,
  WorkPatchSchema,
  type Id,
  type JsonValue,
  type ProposalKind,
  type ProposalStatus,
  type WorkFields,
  type WorkPatch,
} from "./schema.js";
import { migrationSql } from "./tables.js";

export type View = { sessionId: string; revision: number; rootNodeId: Id };
export type NodeRecord = {
  id: Id;
  nodeId: Id;
  sessionId: string;
  revision: number;
  attributes: WorkFields;
  createdAt: string;
};
export type Link = {
  id: Id;
  childNodeId: Id;
  createdSessionId: string;
  createdRevision: number;
  createdAt: string;
};
export type LinkRecord = {
  id: Id;
  linkId: Id;
  sessionId: string;
  revision: number;
  parentNodeId: Id;
  name: string;
  createdAt: string;
};
export type EffectiveLink = LinkRecord & { childNodeId: Id };
export type Session = {
  id: string;
  workspacePath: string;
  rootNodeId: Id;
  headRevision: number;
  cursorLinkPath: Id[];
  parentSessionId: string | null;
  parentSessionRevision: number | null;
  createdAt: string;
  updatedAt: string;
};
export type SessionRevision = View & { createdAt: string };
export type Proposal = {
  id: Id;
  sessionId: string;
  sourceSessionId: string | null;
  sourceRevision: number;
  targetNodeId: Id;
  baseRecordId: Id;
  patch: WorkPatch | null;
  kind: ProposalKind;
  status: ProposalStatus;
  createdAt: string;
  decidedAt: string | null;
};
export type NewProposal = Omit<Proposal, "id">;
export type SessionEvent = {
  sessionId: string;
  revision: number | null;
  rootNodeId: Id | null;
  operation: string;
  cursorLinkPath: Id[];
  idempotencyKey: string | null;
  payload: JsonValue;
};

const RowSchema = z.record(z.string(), z.unknown());
type Row = z.infer<typeof RowSchema>;
type SqlValue = string | number | null;

export class RepositoryError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "invariant", message: string) {
    super(message);
  }
}

export interface RecordRepository {
  transaction<T>(work: () => T): T;
  findSession(id: string): Session | null;
  getSession(id: string): Session;
  insertSession(session: Session): void;
  updateSessionHead(sessionId: string, revision: number, cursorLinkPath: Id[]): void;
  updateSessionCursor(sessionId: string, cursorLinkPath: Id[]): void;
  listSessions(workspacePath: string | null): Session[];
  createNode(sessionId: string, revision: number): Id;
  createLink(childNodeId: Id, sessionId: string, revision: number): Link;
  getLink(id: Id): Link;
  insertNodeRecord(nodeId: Id, sessionId: string, revision: number, attributes: WorkFields): NodeRecord;
  resolveNodeRecord(nodeId: Id, view: View): NodeRecord;
  nextNodeRecord(nodeId: Id, sessionId: string, revision: number): NodeRecord | null;
  insertLinkRecord(linkId: Id, sessionId: string, revision: number, parentNodeId: Id, name: string): LinkRecord;
  resolveLinkRecord(linkId: Id, view: View): LinkRecord;
  nextLinkRecord(linkId: Id, sessionId: string, revision: number): LinkRecord | null;
  listEffectiveLinks(parentNodeId: Id, view: View): EffectiveLink[];
  getSessionRevision(sessionId: string, revision: number): SessionRevision;
  listSessionRevisions(sessionId: string): SessionRevision[];
  appendEvent(event: SessionEvent): void;
  insertProposal(proposal: NewProposal): Proposal;
  listPendingProposals(sessionId: string): Proposal[];
  getPendingProposal(id: Id, sessionId: string): Proposal;
  updateProposalStatus(id: Id, status: ProposalStatus): void;
  findReceipt(sessionId: string, key: string): JsonValue | null;
  saveReceipt(sessionId: string, key: string, result: unknown): void;
}

export class SqliteRecordRepository implements RecordRepository {
  private readonly db: DatabaseSync;

  constructor(file = dataDir() + "/context-tree-v6.sqlite") {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    for (const statement of migrationSql()) this.db.exec(statement);
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  findSession(id: string): Session | null {
    const row = this.one("SELECT * FROM sessions_v6 WHERE id=?", id);
    return row === null ? null : this.session(row);
  }

  getSession(id: string): Session {
    const session = this.findSession(id);
    if (session === null) throw new RepositoryError("not_found", "session not found");
    return session;
  }

  insertSession(session: Session): void {
    this.db.prepare(
      "INSERT INTO sessions_v6(id,workspace_path,root_node_id,head_revision,cursor_link_path_json,parent_session_id,parent_session_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      session.id,
      session.workspacePath,
      session.rootNodeId,
      session.headRevision,
      JSON.stringify(session.cursorLinkPath),
      session.parentSessionId,
      session.parentSessionRevision,
      session.createdAt,
      session.updatedAt,
    );
  }

  updateSessionHead(sessionId: string, revision: number, cursorLinkPath: Id[]): void {
    this.db.prepare(
      "UPDATE sessions_v6 SET head_revision=?,cursor_link_path_json=?,updated_at=? WHERE id=?",
    ).run(revision, JSON.stringify(cursorLinkPath), this.timestamp(), sessionId);
  }

  updateSessionCursor(sessionId: string, cursorLinkPath: Id[]): void {
    this.db.prepare(
      "UPDATE sessions_v6 SET cursor_link_path_json=?,updated_at=? WHERE id=?",
    ).run(JSON.stringify(cursorLinkPath), this.timestamp(), sessionId);
  }

  listSessions(workspacePath: string | null): Session[] {
    const rows = workspacePath === null
      ? this.all("SELECT * FROM sessions_v6")
      : this.all("SELECT * FROM sessions_v6 WHERE workspace_path=?", workspacePath);
    return rows.map((row) => this.session(row));
  }

  createNode(sessionId: string, revision: number): Id {
    return this.insert(
      "INSERT INTO nodes_v6(created_session_id,created_revision,created_at) VALUES(?,?,?)",
      sessionId,
      revision,
      this.timestamp(),
    );
  }

  createLink(childNodeId: Id, sessionId: string, revision: number): Link {
    const id = this.insert(
      "INSERT INTO links_v6(child_node_id,created_session_id,created_revision,created_at) VALUES(?,?,?,?)",
      childNodeId,
      sessionId,
      revision,
      this.timestamp(),
    );
    return this.getLink(id);
  }

  getLink(id: Id): Link {
    const row = this.one("SELECT * FROM links_v6 WHERE id=?", id);
    if (row === null) throw new RepositoryError("not_found", "link not found");
    return {
      id: this.id(row.id),
      childNodeId: this.id(row.child_node_id),
      createdSessionId: String(row.created_session_id),
      createdRevision: Number(row.created_revision),
      createdAt: String(row.created_at),
    };
  }

  insertNodeRecord(nodeId: Id, sessionId: string, revision: number, attributes: WorkFields): NodeRecord {
    const id = this.insert(
      "INSERT INTO node_records_v6(node_id,session_id,revision,work_json,created_at) VALUES(?,?,?,?,?)",
      nodeId,
      sessionId,
      revision,
      JSON.stringify(WorkFieldsSchema.parse(attributes)),
      this.timestamp(),
    );
    return this.getNodeRecord(id);
  }

  resolveNodeRecord(nodeId: Id, view: View): NodeRecord {
    const row = this.resolveHistoryRow("node_records_v6", "node_id", nodeId, view);
    if (row === null) throw new RepositoryError("not_found", "node did not exist in selected revision");
    return this.nodeRecord(row);
  }

  nextNodeRecord(nodeId: Id, sessionId: string, revision: number): NodeRecord | null {
    const row = this.one(
      "SELECT * FROM node_records_v6 WHERE node_id=? AND session_id=? AND revision>? ORDER BY revision LIMIT 1",
      nodeId,
      sessionId,
      revision,
    );
    return row === null ? null : this.nodeRecord(row);
  }

  insertLinkRecord(linkId: Id, sessionId: string, revision: number, parentNodeId: Id, name: string): LinkRecord {
    const id = this.insert(
      "INSERT INTO link_records_v6(link_id,session_id,revision,parent_node_id,name,created_at) VALUES(?,?,?,?,?,?)",
      linkId,
      sessionId,
      revision,
      parentNodeId,
      name,
      this.timestamp(),
    );
    return this.getLinkRecord(id);
  }

  resolveLinkRecord(linkId: Id, view: View): LinkRecord {
    const row = this.resolveHistoryRow("link_records_v6", "link_id", linkId, view);
    if (row === null) throw new RepositoryError("not_found", "link did not exist in selected revision");
    return this.linkRecord(row);
  }

  nextLinkRecord(linkId: Id, sessionId: string, revision: number): LinkRecord | null {
    const row = this.one(
      "SELECT * FROM link_records_v6 WHERE link_id=? AND session_id=? AND revision>? ORDER BY revision LIMIT 1",
      linkId,
      sessionId,
      revision,
    );
    return row === null ? null : this.linkRecord(row);
  }

  listEffectiveLinks(parentNodeId: Id, view: View): EffectiveLink[] {
    const rows = this.all(
      "WITH RECURSIVE lineage(session_id,max_revision,depth) AS (" +
      "SELECT ?,?,0 UNION ALL " +
      "SELECT s.parent_session_id,s.parent_session_revision,lineage.depth+1 " +
      "FROM sessions_v6 s JOIN lineage ON s.id=lineage.session_id " +
      "WHERE s.parent_session_id IS NOT NULL" +
      "), ranked AS (" +
      "SELECT r.*,l.depth,ROW_NUMBER() OVER(PARTITION BY r.link_id ORDER BY l.depth,r.revision DESC) AS rank " +
      "FROM lineage l JOIN link_records_v6 r ON r.session_id=l.session_id AND r.revision<=l.max_revision" +
      ") SELECT ranked.*,links_v6.child_node_id FROM ranked JOIN links_v6 ON links_v6.id=ranked.link_id " +
      "WHERE ranked.rank=1 AND ranked.parent_node_id=? ORDER BY ranked.name,ranked.link_id",
      view.sessionId,
      view.revision,
      parentNodeId,
    );
    return rows.map((row) => ({ ...this.linkRecord(row), childNodeId: this.id(row.child_node_id) }));
  }

  getSessionRevision(sessionId: string, revision: number): SessionRevision {
    const row = this.one(
      "SELECT session_id,revision,root_node_id,created_at FROM session_events_v6 WHERE session_id=? AND revision=?",
      sessionId,
      revision,
    );
    if (row === null) throw new RepositoryError("not_found", "session revision not found: r" + revision);
    return this.sessionRevision(row);
  }

  listSessionRevisions(sessionId: string): SessionRevision[] {
    return this.all(
      "SELECT session_id,revision,root_node_id,created_at FROM session_events_v6 WHERE session_id=? AND revision IS NOT NULL ORDER BY revision",
      sessionId,
    ).map((row) => this.sessionRevision(row));
  }

  appendEvent(event: SessionEvent): void {
    this.db.prepare(
      "INSERT INTO session_events_v6(session_id,revision,root_node_id,operation,cursor_link_path_json,idempotency_key,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      event.sessionId,
      event.revision,
      event.rootNodeId,
      event.operation,
      JSON.stringify(event.cursorLinkPath),
      event.idempotencyKey,
      JSON.stringify(JsonSchema.parse(event.payload)),
      this.timestamp(),
    );
  }

  insertProposal(proposal: NewProposal): Proposal {
    const id = this.insert(
      "INSERT INTO proposals_v6(session_id,source_session_id,source_revision,target_node_id,base_record_id,patch_json,kind,status,created_at,decided_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      proposal.sessionId,
      proposal.sourceSessionId,
      proposal.sourceRevision,
      proposal.targetNodeId,
      proposal.baseRecordId,
      proposal.patch === null ? null : JSON.stringify(WorkPatchSchema.parse(proposal.patch)),
      proposal.kind,
      proposal.status,
      proposal.createdAt,
      proposal.decidedAt,
    );
    return this.getProposal(id);
  }

  listPendingProposals(sessionId: string): Proposal[] {
    return this.all("SELECT * FROM proposals_v6 WHERE session_id=? AND status='pending' ORDER BY created_at", sessionId)
      .map((row) => this.proposal(row));
  }

  getPendingProposal(id: Id, sessionId: string): Proposal {
    const row = this.one("SELECT * FROM proposals_v6 WHERE id=? AND session_id=? AND status='pending'", id, sessionId);
    if (row === null) throw new RepositoryError("not_found", "pending proposal not found");
    return this.proposal(row);
  }

  updateProposalStatus(id: Id, status: ProposalStatus): void {
    this.db.prepare("UPDATE proposals_v6 SET status=?,decided_at=? WHERE id=?").run(status, this.timestamp(), id);
  }

  findReceipt(sessionId: string, key: string): JsonValue | null {
    const row = this.one("SELECT result_json FROM receipts_v6 WHERE session_id=? AND idempotency_key=?", sessionId, key);
    return row === null ? null : JsonSchema.parse(JSON.parse(String(row.result_json)));
  }

  saveReceipt(sessionId: string, key: string, result: unknown): void {
    this.db.prepare("INSERT INTO receipts_v6(session_id,idempotency_key,result_json,created_at) VALUES(?,?,?,?)")
      .run(sessionId, key, JSON.stringify(JsonSchema.parse(result)), this.timestamp());
  }

  private resolveHistoryRow(table: "node_records_v6" | "link_records_v6", idColumn: "node_id" | "link_id", id: Id, view: View): Row | null {
    return this.one(
      "WITH RECURSIVE lineage(session_id,max_revision,depth) AS (" +
      "SELECT ?,?,0 UNION ALL " +
      "SELECT s.parent_session_id,s.parent_session_revision,lineage.depth+1 " +
      "FROM sessions_v6 s JOIN lineage ON s.id=lineage.session_id " +
      "WHERE s.parent_session_id IS NOT NULL" +
      ") SELECT r.* FROM lineage l JOIN " + table + " r ON r.session_id=l.session_id " +
      "AND r.revision<=l.max_revision WHERE r." + idColumn + "=? ORDER BY l.depth,r.revision DESC LIMIT 1",
      view.sessionId,
      view.revision,
      id,
    );
  }

  private getNodeRecord(id: Id): NodeRecord {
    const row = this.one("SELECT * FROM node_records_v6 WHERE id=?", id);
    if (row === null) throw new RepositoryError("not_found", "node record not found");
    return this.nodeRecord(row);
  }

  private getProposal(id: Id): Proposal {
    const row = this.one("SELECT * FROM proposals_v6 WHERE id=?", id);
    if (row === null) throw new RepositoryError("not_found", "proposal not found");
    return this.proposal(row);
  }

  private getLinkRecord(id: Id): LinkRecord {
    const row = this.one("SELECT * FROM link_records_v6 WHERE id=?", id);
    if (row === null) throw new RepositoryError("not_found", "link record not found");
    return this.linkRecord(row);
  }

  private nodeRecord(row: Row): NodeRecord {
    return {
      id: this.id(row.id),
      nodeId: this.id(row.node_id),
      sessionId: String(row.session_id),
      revision: Number(row.revision),
      attributes: this.json(WorkFieldsSchema, row.work_json),
      createdAt: String(row.created_at),
    };
  }

  private linkRecord(row: Row): LinkRecord {
    return {
      id: this.id(row.id),
      linkId: this.id(row.link_id),
      sessionId: String(row.session_id),
      revision: Number(row.revision),
      parentNodeId: this.id(row.parent_node_id),
      name: String(row.name),
      createdAt: String(row.created_at),
    };
  }

  private session(row: Row): Session {
    return {
      id: String(row.id),
      workspacePath: String(row.workspace_path),
      rootNodeId: this.id(row.root_node_id),
      headRevision: Number(row.head_revision),
      cursorLinkPath: this.json(z.array(IdSchema), row.cursor_link_path_json),
      parentSessionId: row.parent_session_id === null ? null : String(row.parent_session_id),
      parentSessionRevision: row.parent_session_revision === null ? null : Number(row.parent_session_revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private sessionRevision(row: Row): SessionRevision {
    return {
      sessionId: String(row.session_id),
      revision: Number(row.revision),
      rootNodeId: this.id(row.root_node_id),
      createdAt: String(row.created_at),
    };
  }

  private proposal(row: Row): Proposal {
    return {
      id: this.id(row.id),
      sessionId: String(row.session_id),
      sourceSessionId: row.source_session_id === null ? null : String(row.source_session_id),
      sourceRevision: Number(row.source_revision),
      targetNodeId: this.id(row.target_node_id),
      baseRecordId: this.id(row.base_record_id),
      patch: row.patch_json === null ? null : WorkPatchSchema.parse(JSON.parse(String(row.patch_json))),
      kind: ProposalKindSchema.parse(row.kind),
      status: ProposalStatusSchema.parse(row.status),
      createdAt: String(row.created_at),
      decidedAt: row.decided_at === null ? null : String(row.decided_at),
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
    if (row === undefined) throw new RepositoryError("invariant", "insert did not return id");
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
