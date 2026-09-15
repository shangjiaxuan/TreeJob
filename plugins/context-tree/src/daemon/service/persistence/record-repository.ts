import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  JsonSchema,
  ProposalKindSchema,
  ProposalStatusSchema,
  WorkFieldsSchema,
  WorkPatchSchema,
  type JsonValue,
  type ProposalKind,
  type ProposalStatus,
  type WorkFields,
  type WorkPatch,
} from "../../../protocol/schema.js";
import { migrationSql } from "./tables.js";

export type Id = number;

const IdSchema = z.number().int().positive();
const RowSchema = z.record(z.string(), z.unknown());
const SessionEventDocumentSchema = z.object({
  rootNodeId: IdSchema.nullable(),
  action: z.string().min(1),
  cursorLinkPath: z.array(IdSchema),
  idempotencyKey: z.string().min(1).nullable(),
  details: JsonSchema,
  createdAt: z.string().datetime(),
}).strict();

type Row = z.infer<typeof RowSchema>;
type SqlValue = string | number | null;
type Span = {
  sessionId: string;
  firstRevision: number;
  sourceSessionId: string | null;
  sourceRevision: number | null;
};
type PublishedRecord = { recordId: Id; sessionId: string; revision: number };
type PublishedLinkRecord = PublishedRecord & { linkId: Id };

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
  headRevisionCreatedAt: string;
  cursorLinkPath: Id[];
  createdAt: string;
  updatedAt: string;
};
export type SessionRevision = View & { createdAt: string };
export type HeadSessionView = { session: Session; view: SessionRevision };
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
export type SessionEventDocument = z.infer<typeof SessionEventDocumentSchema>;

export class RepositoryError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "invariant", message: string) {
    super(message);
  }
}

export interface RecordRepository {
  close(): void;
  transaction<T>(work: () => T): T;
  findSession(id: string): Session | null;
  getSession(id: string): Session;
  getHeadSessionView(id: string): HeadSessionView;
  insertSession(session: Session): void;
  updateSessionHead(sessionId: string, revision: number, cursorLinkPath: Id[]): void;
  updateSessionCursor(sessionId: string, cursorLinkPath: Id[]): void;
  listSessions(workspacePath: string | null): Session[];
  createNode(): Id;
  createLink(childNodeId: Id): Link;
  getLink(id: Id): Link;
  insertNodeRecord(nodeId: Id, attributes: WorkFields): NodeRecord;
  getNodeRecord(id: Id): NodeRecord;
  resolveNodeRecord(nodeId: Id, view: View): NodeRecord;
  firstNodeChangeAfter(nodeId: Id, sessionId: string, revision: number): NodeRecord | null;
  insertLinkRecord(linkId: Id, parentNodeId: Id, name: string): LinkRecord;
  resolveLinkRecord(linkId: Id, view: View): LinkRecord;
  firstLinkChangeAfter(linkId: Id, sessionId: string, revision: number): LinkRecord | null;
  listVisibleLinkRecords(linkId: Id, view: View): LinkRecord[];
  listEffectiveLinks(parentNodeId: Id, view: View): EffectiveLink[];
  reserveNextRevision(sessionId: string): number;
  publishReferences(sessionId: string, revision: number, nodeRecords: readonly NodeRecord[], linkRecords: readonly { record: LinkRecord; previousParentNodeId: Id | null }[]): void;
  insertSpan(sessionId: string, firstRevision: number, source: View | null): void;
  getSessionRevision(sessionId: string, revision: number): SessionRevision;
  listSessionRevisions(sessionId: string): SessionRevision[];
  appendEvent(sessionId: string, revision: number | null, event: SessionEventDocument): void;
  insertProposal(proposal: NewProposal): Proposal;
  listPendingProposals(sessionId: string): Proposal[];
  getPendingProposal(id: Id, sessionId: string): Proposal;
  updateProposalStatus(id: Id, status: ProposalStatus): void;
  findReceipt(sessionId: string, key: string): JsonValue | null;
  saveReceipt(sessionId: string, key: string, result: unknown): void;
}

/**
 * Reads use only primary-key/index probes. Session spans are followed in
 * application code, never by a recursive SQL query or an event replay.
 */
export class SqliteRecordRepository implements RecordRepository {
  private readonly db: DatabaseSync;

  constructor(file: string) {
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

  close(): void {
    this.db.close();
  }

  findSession(id: string): Session | null {
    const row = this.one("SELECT * FROM sessions_v8 WHERE id=?", id);
    return row === null ? null : this.session(row);
  }

  getSession(id: string): Session {
    const session = this.findSession(id);
    if (session === null) throw new RepositoryError("not_found", "session not found");
    return session;
  }

  getHeadSessionView(id: string): HeadSessionView {
    const session = this.getSession(id);
    return {
      session,
      view: {
        sessionId: session.id,
        revision: session.headRevision,
        rootNodeId: session.rootNodeId,
        createdAt: session.headRevisionCreatedAt,
      },
    };
  }

  insertSession(session: Session): void {
    this.db.prepare(
      "INSERT INTO sessions_v8(id,workspace_path,root_inode_id,head_revision,head_revision_created_at,cursor_link_path_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      session.id,
      session.workspacePath,
      session.rootNodeId,
      session.headRevision,
      session.headRevisionCreatedAt,
      JSON.stringify(session.cursorLinkPath),
      session.createdAt,
      session.updatedAt,
    );
  }

  updateSessionHead(sessionId: string, revision: number, cursorLinkPath: Id[]): void {
    const timestamp = this.timestamp();
    this.db.prepare(
      "UPDATE sessions_v8 SET head_revision=?,head_revision_created_at=?,cursor_link_path_json=?,updated_at=? WHERE id=?",
    ).run(revision, timestamp, JSON.stringify(cursorLinkPath), timestamp, sessionId);
  }

  updateSessionCursor(sessionId: string, cursorLinkPath: Id[]): void {
    this.db.prepare("UPDATE sessions_v8 SET cursor_link_path_json=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(cursorLinkPath), this.timestamp(), sessionId);
  }

  listSessions(workspacePath: string | null): Session[] {
    const rows = workspacePath === null
      ? this.all("SELECT * FROM sessions_v8")
      : this.all("SELECT * FROM sessions_v8 WHERE workspace_path=?", workspacePath);
    return rows.map((row) => this.session(row));
  }

  createNode(): Id {
    return this.insert(
      "INSERT INTO inodes_v8(created_at) VALUES(?)",
      this.timestamp(),
    );
  }

  createLink(childNodeId: Id): Link {
    const id = this.insert(
      "INSERT INTO links_v8(child_inode_id,created_at) VALUES(?,?)",
      childNodeId,
      this.timestamp(),
    );
    return this.getLink(id);
  }

  getLink(id: Id): Link {
    const row = this.one("SELECT * FROM links_v8 WHERE id=?", id);
    if (row === null) throw new RepositoryError("not_found", "link not found");
    return {
      id: this.id(row.id),
      childNodeId: this.id(row.child_inode_id),
      createdAt: String(row.created_at),
    };
  }

  insertNodeRecord(nodeId: Id, attributes: WorkFields): NodeRecord {
    const createdAt = this.timestamp();
    const payloadId = this.insert(
      "INSERT INTO payload_records_v8(work_json,created_at) VALUES(?,?)",
      JSON.stringify(WorkFieldsSchema.parse(attributes)),
      createdAt,
    );
    const id = this.insert(
      "INSERT INTO node_records_v8(inode_id,payload_record_id,created_at) VALUES(?,?,?)",
      nodeId,
      payloadId,
      createdAt,
    );
    return { id, nodeId, sessionId: "", revision: 0, attributes: WorkFieldsSchema.parse(attributes), createdAt };
  }

  getNodeRecord(id: Id): NodeRecord {
    const row = this.one("SELECT id,inode_id,payload_record_id,created_at FROM node_records_v8 WHERE id=?", id);
    if (row === null) throw new RepositoryError("not_found", "node record not found");
    return this.nodeRecord(row, null);
  }

  resolveNodeRecord(nodeId: Id, view: View): NodeRecord {
    const published = this.resolvePublishedNode(nodeId, view);
    const record = this.getNodeRecord(published.recordId);
    return { ...record, sessionId: published.sessionId, revision: published.revision };
  }

  firstNodeChangeAfter(nodeId: Id, sessionId: string, revision: number): NodeRecord | null {
    const row = this.one(
      "SELECT record_id,revision FROM published_node_refs_v8 WHERE session_id=? AND inode_id=? AND revision>? ORDER BY revision LIMIT 1",
      sessionId,
      nodeId,
      revision,
    );
    if (row === null) return null;
    const record = this.getNodeRecord(this.id(row.record_id));
    return { ...record, sessionId, revision: Number(row.revision) };
  }

  insertLinkRecord(linkId: Id, parentNodeId: Id, name: string): LinkRecord {
    const createdAt = this.timestamp();
    const id = this.insert(
      "INSERT INTO link_records_v8(link_id,parent_inode_id,name,created_at) VALUES(?,?,?,?)",
      linkId,
      parentNodeId,
      name,
      createdAt,
    );
    return { id, linkId, sessionId: "", revision: 0, parentNodeId, name, createdAt };
  }

  resolveLinkRecord(linkId: Id, view: View): LinkRecord {
    const published = this.resolvePublishedLink(linkId, view);
    const record = this.getLinkRecord(published.recordId);
    return { ...record, sessionId: published.sessionId, revision: published.revision };
  }

  firstLinkChangeAfter(linkId: Id, sessionId: string, revision: number): LinkRecord | null {
    const row = this.one(
      "SELECT record_id,revision FROM published_link_refs_v8 WHERE session_id=? AND link_id=? AND revision>? ORDER BY revision LIMIT 1",
      sessionId,
      linkId,
      revision,
    );
    if (row === null) return null;
    const record = this.getLinkRecord(this.id(row.record_id));
    return { ...record, sessionId, revision: Number(row.revision) };
  }

  listVisibleLinkRecords(linkId: Id, view: View): LinkRecord[] {
    const records: LinkRecord[] = [];
    const seen = new Set<Id>();
    for (const revision of this.listSessionRevisions(view.sessionId)) {
      if (revision.revision > view.revision) break;
      try {
        const record = this.resolveLinkRecord(linkId, revision);
        if (!seen.has(record.id)) {
          seen.add(record.id);
          records.push(record);
        }
      } catch (error) {
        if (!(error instanceof RepositoryError) || error.code !== "not_found") throw error;
      }
    }
    return records;
  }

  listEffectiveLinks(parentNodeId: Id, view: View): EffectiveLink[] {
    const selected = new Map<Id, EffectiveLink | null>();
    let sessionId = view.sessionId;
    let revision = view.revision;

    while (true) {
      const span = this.spanAt(sessionId, revision);
      const candidates = this.parentLinkCandidates(sessionId, span.firstRevision, revision, parentNodeId);

      for (const candidate of candidates) {
        if (selected.has(candidate.linkId)) continue;
        const record = this.getLinkRecord(candidate.recordId);
        if (record.parentNodeId !== parentNodeId) {
          selected.set(candidate.linkId, null);
          continue;
        }
        const stable = this.getLink(candidate.linkId);
        selected.set(candidate.linkId, {
          ...record,
          sessionId: candidate.sessionId,
          revision: candidate.revision,
          childNodeId: stable.childNodeId,
        });
      }

      if (span.sourceSessionId === null || span.sourceRevision === null) break;
      sessionId = span.sourceSessionId;
      revision = span.sourceRevision;
    }

    return [...selected.values()]
      .filter((link): link is EffectiveLink => link !== null)
      .sort((left, right) => left.name.localeCompare(right.name) || left.linkId - right.linkId);
  }

  reserveNextRevision(sessionId: string): number {
    const session = this.getSession(sessionId);
    const revision = session.headRevision + 1;
    this.db.prepare("INSERT INTO session_revisions_v8(session_id,revision,created_at) VALUES(?,?,?)")
      .run(sessionId, revision, this.timestamp());
    return revision;
  }

  publishReferences(
    sessionId: string,
    revision: number,
    nodeRecords: readonly NodeRecord[],
    linkRecords: readonly { record: LinkRecord; previousParentNodeId: Id | null }[],
  ): void {
    for (const record of nodeRecords) {
      this.db.prepare(
        "INSERT INTO published_node_refs_v8(session_id,inode_id,revision,record_id) VALUES(?,?,?,?)",
      ).run(sessionId, record.nodeId, revision, record.id);
    }

    for (const reference of linkRecords) {
      this.db.prepare(
        "INSERT INTO published_link_refs_v8(session_id,link_id,revision,record_id,parent_inode_id,previous_parent_inode_id) VALUES(?,?,?,?,?,?)",
      ).run(
        sessionId,
        reference.record.linkId,
        revision,
        reference.record.id,
        reference.record.parentNodeId,
        reference.previousParentNodeId,
      );
    }
  }

  insertSpan(sessionId: string, firstRevision: number, source: View | null): void {
    this.db.prepare(
      "INSERT INTO session_spans_v8(session_id,first_revision,source_session_id,source_revision) VALUES(?,?,?,?)",
    ).run(sessionId, firstRevision, source?.sessionId ?? null, source?.revision ?? null);
  }

  getSessionRevision(sessionId: string, revision: number): SessionRevision {
    const row = this.one(
      "SELECT created_at FROM session_revisions_v8 WHERE session_id=? AND revision=?",
      sessionId,
      revision,
    );
    if (row === null) throw new RepositoryError("not_found", "session revision not found: r" + revision);
    const session = this.getSession(sessionId);
    return { sessionId, revision, rootNodeId: session.rootNodeId, createdAt: String(row.created_at) };
  }

  listSessionRevisions(sessionId: string): SessionRevision[] {
    const session = this.getSession(sessionId);
    return this.all("SELECT revision,created_at FROM session_revisions_v8 WHERE session_id=? ORDER BY revision", sessionId)
      .map((row) => ({
        sessionId,
        revision: Number(row.revision),
        rootNodeId: session.rootNodeId,
        createdAt: String(row.created_at),
      }));
  }

  appendEvent(sessionId: string, revision: number | null, event: SessionEventDocument): void {
    const document = SessionEventDocumentSchema.parse(event);
    this.db.prepare("INSERT INTO session_events_v8(session_id,revision,event_json) VALUES(?,?,?)")
      .run(sessionId, revision, JSON.stringify(document));
  }

  insertProposal(proposal: NewProposal): Proposal {
    const id = this.insert(
      "INSERT INTO proposals_v8(session_id,source_session_id,source_revision,target_node_id,base_record_id,patch_json,kind,status,created_at,decided_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
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
    return this.all("SELECT * FROM proposals_v8 WHERE session_id=? AND status='pending' ORDER BY created_at", sessionId)
      .map((row) => this.proposal(row));
  }

  getPendingProposal(id: Id, sessionId: string): Proposal {
    const row = this.one("SELECT * FROM proposals_v8 WHERE id=? AND session_id=? AND status='pending'", id, sessionId);
    if (row === null) throw new RepositoryError("not_found", "pending proposal not found");
    return this.proposal(row);
  }

  updateProposalStatus(id: Id, status: ProposalStatus): void {
    this.db.prepare("UPDATE proposals_v8 SET status=?,decided_at=? WHERE id=?")
      .run(status, this.timestamp(), id);
  }

  findReceipt(sessionId: string, key: string): JsonValue | null {
    const row = this.one("SELECT result_json FROM receipts_v8 WHERE session_id=? AND idempotency_key=?", sessionId, key);
    return row === null ? null : JsonSchema.parse(JSON.parse(String(row.result_json)));
  }

  saveReceipt(sessionId: string, key: string, result: unknown): void {
    this.db.prepare("INSERT INTO receipts_v8(session_id,idempotency_key,result_json,created_at) VALUES(?,?,?,?)")
      .run(sessionId, key, JSON.stringify(JsonSchema.parse(result)), this.timestamp());
  }

  private resolvePublishedNode(nodeId: Id, view: View): PublishedRecord {
    return this.resolvePublished("published_node_refs_v8", "inode_id", nodeId, view);
  }

  private resolvePublishedLink(linkId: Id, view: View): PublishedRecord {
    return this.resolvePublished("published_link_refs_v8", "link_id", linkId, view);
  }

  private resolvePublished(
    table: "published_node_refs_v8" | "published_link_refs_v8",
    identityColumn: "inode_id" | "link_id",
    identity: Id,
    view: View,
  ): PublishedRecord {
    let sessionId = view.sessionId;
    let revision = view.revision;

    while (true) {
      const span = this.spanAt(sessionId, revision);
      const row = this.one(
        "SELECT record_id,revision FROM " + table + " WHERE session_id=? AND " + identityColumn + "=? AND revision>=? AND revision<=? ORDER BY revision DESC LIMIT 1",
        sessionId,
        identity,
        span.firstRevision,
        revision,
      );
      if (row !== null) {
        return { recordId: this.id(row.record_id), sessionId, revision: Number(row.revision) };
      }
      if (span.sourceSessionId === null || span.sourceRevision === null) {
        throw new RepositoryError("not_found", "record did not exist in selected revision");
      }
      sessionId = span.sourceSessionId;
      revision = span.sourceRevision;
    }
  }

  private spanAt(sessionId: string, revision: number): Span {
    const row = this.one(
      "SELECT * FROM session_spans_v8 WHERE session_id=? AND first_revision<=? ORDER BY first_revision DESC LIMIT 1",
      sessionId,
      revision,
    );
    if (row === null) throw new RepositoryError("invariant", "session view has no resolution span");
    return {
      sessionId: String(row.session_id),
      firstRevision: Number(row.first_revision),
      sourceSessionId: row.source_session_id === null ? null : String(row.source_session_id),
      sourceRevision: row.source_revision === null ? null : Number(row.source_revision),
    };
  }

  private parentLinkCandidates(sessionId: string, firstRevision: number, revision: number, parentNodeId: Id): PublishedLinkRecord[] {
    const present = this.all(
      "SELECT link_id,record_id,revision FROM published_link_refs_v8 WHERE session_id=? AND parent_inode_id=? AND revision>=? AND revision<=? ORDER BY revision DESC",
      sessionId,
      parentNodeId,
      firstRevision,
      revision,
    );
    const removed = this.all(
      "SELECT link_id,record_id,revision FROM published_link_refs_v8 WHERE session_id=? AND previous_parent_inode_id=? AND revision>=? AND revision<=? ORDER BY revision DESC",
      sessionId,
      parentNodeId,
      firstRevision,
      revision,
    );
    return [...present, ...removed]
      .sort((left, right) => Number(right.revision) - Number(left.revision))
      .map((row) => ({ recordId: this.id(row.record_id), sessionId, revision: Number(row.revision), linkId: this.id(row.link_id) }));
  }

  private getLinkRecord(id: Id): LinkRecord {
    const row = this.one("SELECT * FROM link_records_v8 WHERE id=?", id);
    if (row === null) throw new RepositoryError("not_found", "link record not found");
    return {
      id: this.id(row.id),
      linkId: this.id(row.link_id),
      sessionId: "",
      revision: 0,
      parentNodeId: this.id(row.parent_inode_id),
      name: String(row.name),
      createdAt: String(row.created_at),
    };
  }

  private nodeRecord(row: Row, publication: PublishedRecord | null): NodeRecord {
    const payload = this.one("SELECT work_json FROM payload_records_v8 WHERE id=?", this.id(row.payload_record_id));
    if (payload === null) throw new RepositoryError("invariant", "node record is missing its payload");
    return {
      id: this.id(row.id),
      nodeId: this.id(row.inode_id),
      sessionId: publication?.sessionId ?? "",
      revision: publication?.revision ?? 0,
      attributes: this.json(WorkFieldsSchema, payload.work_json),
      createdAt: String(row.created_at),
    };
  }

  private getProposal(id: Id): Proposal {
    const row = this.one("SELECT * FROM proposals_v8 WHERE id=?", id);
    if (row === null) throw new RepositoryError("not_found", "proposal not found");
    return this.proposal(row);
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

  private session(row: Row): Session {
    return {
      id: String(row.id),
      workspacePath: String(row.workspace_path),
      rootNodeId: this.id(row.root_inode_id),
      headRevision: Number(row.head_revision),
      headRevisionCreatedAt: String(row.head_revision_created_at),
      cursorLinkPath: this.json(z.array(IdSchema), row.cursor_link_path_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
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
