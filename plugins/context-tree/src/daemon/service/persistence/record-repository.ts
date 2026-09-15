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
  branchId: Id;
  firstRevision: number;
  sourceBranchId: Id | null;
  sourceRevision: number | null;
};
type PublishedRecord = { recordId: Id; branchId: Id; revision: number };
type PublishedLinkRecord = PublishedRecord & { linkId: Id };

export type View = {
  sessionId: string;
  branchId: Id;
  revision: number;
  rootNodeId: Id;
  overlaySessionId: string | null;
  overlayHeadRevision: number;
};
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
  userId: string;
  groups: string[];
  metadata: Record<string, JsonValue>;
  workspacePath: string;
  rootNodeId: Id;
  branchId: Id;
  headRevision: number;
  headRevisionCreatedAt: string;
  cursorLinkPath: Id[];
  overlayHeadRevision: number;
  createdAt: string;
  updatedAt: string;
};
export type Access = { content: number; topology: number };
export type Inode = { id: Id; ownerUserId: string; groupId: string | null; access: Access; createdAt: string };
export type OverlaySubject = "inode" | "link";
export type Overlay = {
  sessionId: string; subjectKind: OverlaySubject; subjectId: Id; overlayRevision: number;
  baseBranchId: Id; baseBranchRevision: number; baseRecordId: Id; candidateRecordId: Id;
  parentNodeId: Id | null; createdAt: string;
};
export type MailboxEntry = {
  authorityInodeId: Id; subjectKind: OverlaySubject; subjectId: Id; authorSessionId: string;
  publishedOverlayRevision: number; baseBranchId: Id; baseBranchRevision: number;
  baseRecordId: Id; candidateRecordId: Id; publishedAt: string;
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
  setIdentity(id: string, userId: string, groups: string[], metadata: Record<string, JsonValue>): Session;
  findFilesystem(workspacePath: string): { id: Id; rootNodeId: Id; mainBranchId: Id } | null;
  createFilesystem(workspacePath: string, rootNodeId: Id): Id;
  createMainBranch(filesystemId: Id): Id;
  setFilesystemMainBranch(filesystemId: Id, branchId: Id): void;
  attachSession(sessionId: string, filesystemId: Id, branchId: Id, cursorLinkPath: Id[]): void;
  insertSession(session: Session): void;
  updateSessionHead(sessionId: string, revision: number, cursorLinkPath: Id[]): void;
  updateSessionCursor(sessionId: string, cursorLinkPath: Id[]): void;
  listSessions(workspacePath: string | null): Session[];
  createNode(ownerUserId: string, groupId?: string | null, access?: Access): Id;
  getInode(id: Id): Inode;
  updateInodeAccess(id: Id, access: Access, groupId: string | null): void;
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
  reserveNextRevision(branchId: Id): number;
  publishReferences(branchId: Id, revision: number, nodeRecords: readonly NodeRecord[], linkRecords: readonly { record: LinkRecord; previousParentNodeId: Id | null }[]): void;
  insertSpan(branchId: Id, firstRevision: number, source: View | null): void;
  getSessionRevision(sessionId: string, revision: number): SessionRevision;
  listSessionRevisions(sessionId: string): SessionRevision[];
  appendEvent(sessionId: string, revision: number | null, event: SessionEventDocument): void;
  insertProposal(proposal: NewProposal): Proposal;
  listPendingProposals(sessionId: string): Proposal[];
  getPendingProposal(id: Id, sessionId: string): Proposal;
  updateProposalStatus(id: Id, status: ProposalStatus): void;
  findReceipt(sessionId: string, key: string): JsonValue | null;
  saveReceipt(sessionId: string, key: string, result: unknown): void;
  appendOverlay(overlay: Overlay): void;
  latestOverlay(sessionId: string, subjectKind: OverlaySubject, subjectId: Id, head: number): Overlay | null;
  listLatestLinkOverlays(sessionId: string, head: number, parentNodeId: Id): Overlay[];
  publishMailbox(entry: MailboxEntry): void;
  getMailbox(authorityInodeId: Id, subjectKind: OverlaySubject, subjectId: Id, authorSessionId: string): MailboxEntry | null;
  withdrawMailbox(authorityInodeId: Id, subjectKind: OverlaySubject, subjectId: Id, authorSessionId: string): void;
  listMailbox(authorityOwnerUserId: string): MailboxEntry[];
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
    const row = this.one("SELECT * FROM sessions_v9 WHERE id=?", id);
    return row === null ? null : this.session(row);
  }

  getSession(id: string): Session {
    const session = this.findSession(id);
    if (session === null) throw new RepositoryError("not_found", "session not found");
    return session;
  }

  setIdentity(id: string, userId: string, groups: string[], metadata: Record<string, JsonValue>): Session {
    const existing = this.findSession(id);
    const timestamp = this.timestamp();
    if (existing === null) {
      this.db.prepare(
        "INSERT INTO sessions_v9(id,user_id,groups_json,metadata_json,filesystem_id,current_branch_id,cursor_link_path_json,overlay_head_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(id, userId, JSON.stringify(groups), JSON.stringify(metadata), null, null, "[]", 0, timestamp, timestamp);
    } else {
      this.db.prepare("UPDATE sessions_v9 SET user_id=?,groups_json=?,metadata_json=?,updated_at=? WHERE id=?")
        .run(userId, JSON.stringify(groups), JSON.stringify(metadata), timestamp, id);
    }
    return this.getSession(id);
  }

  getHeadSessionView(id: string): HeadSessionView {
    const session = this.getSession(id);
    return {
      session,
      view: {
        sessionId: session.id,
        branchId: session.branchId,
        revision: session.headRevision,
        rootNodeId: session.rootNodeId,
        overlaySessionId: session.id,
        overlayHeadRevision: session.overlayHeadRevision,
        createdAt: session.headRevisionCreatedAt,
      },
    };
  }

  findFilesystem(workspacePath: string): { id: Id; rootNodeId: Id; mainBranchId: Id } | null {
    const row = this.one("SELECT * FROM filesystems_v9 WHERE workspace_path=?", workspacePath);
    if (row === null || row.main_branch_id === null) return null;
    return { id: this.id(row.id), rootNodeId: this.id(row.root_inode_id), mainBranchId: this.id(row.main_branch_id) };
  }

  createFilesystem(workspacePath: string, rootNodeId: Id): Id {
    return this.insert(
      "INSERT INTO filesystems_v9(workspace_path,root_inode_id,main_branch_id,created_at) VALUES(?,?,NULL,?)",
      workspacePath,
      rootNodeId,
      this.timestamp(),
    );
  }

  createMainBranch(filesystemId: Id): Id {
    const timestamp = this.timestamp();
    return this.insert(
      "INSERT INTO branches_v9(filesystem_id,name,kind,head_revision,head_revision_created_at,created_at) VALUES(?,?,?,?,?,?)",
      filesystemId,
      "main",
      "main",
      -1,
      timestamp,
      timestamp,
    );
  }

  setFilesystemMainBranch(filesystemId: Id, branchId: Id): void {
    this.db.prepare("UPDATE filesystems_v9 SET main_branch_id=? WHERE id=?").run(branchId, filesystemId);
  }

  attachSession(sessionId: string, filesystemId: Id, branchId: Id, cursorLinkPath: Id[]): void {
    this.db.prepare("UPDATE sessions_v9 SET filesystem_id=?,current_branch_id=?,cursor_link_path_json=?,updated_at=? WHERE id=?")
      .run(filesystemId, branchId, JSON.stringify(cursorLinkPath), this.timestamp(), sessionId);
  }

  insertSession(session: Session): void {
    this.db.prepare(
      "INSERT INTO sessions_v9(id,user_id,groups_json,metadata_json,filesystem_id,current_branch_id,cursor_link_path_json,overlay_head_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      session.id,
      session.userId,
      JSON.stringify(session.groups),
      JSON.stringify(session.metadata),
      null,
      null,
      JSON.stringify(session.cursorLinkPath),
      0,
      session.createdAt,
      session.updatedAt,
    );
  }

  updateSessionHead(sessionId: string, revision: number, cursorLinkPath: Id[]): void {
    const timestamp = this.timestamp();
    const session = this.getSession(sessionId);
    this.db.prepare("UPDATE branches_v9 SET head_revision=?,head_revision_created_at=? WHERE id=?")
      .run(revision, timestamp, session.branchId);
    this.db.prepare("UPDATE sessions_v9 SET cursor_link_path_json=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(cursorLinkPath), timestamp, sessionId);
  }

  updateSessionCursor(sessionId: string, cursorLinkPath: Id[]): void {
    this.db.prepare("UPDATE sessions_v9 SET cursor_link_path_json=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(cursorLinkPath), this.timestamp(), sessionId);
  }

  listSessions(workspacePath: string | null): Session[] {
    const rows = workspacePath === null
      ? this.all("SELECT * FROM sessions_v9 WHERE current_branch_id IS NOT NULL")
      : this.all("SELECT s.* FROM sessions_v9 s JOIN filesystems_v9 f ON f.id=s.filesystem_id WHERE f.workspace_path=?", workspacePath);
    return rows.map((row) => this.session(row));
  }

  createNode(ownerUserId: string, groupId: string | null = null, access: Access = { content: 0o744, topology: 0o766 }): Id {
    return this.insert(
      "INSERT INTO inodes_v9(owner_user_id,group_id,content_access,topology_access,created_at) VALUES(?,?,?,?,?)",
      ownerUserId,
      groupId,
      access.content,
      access.topology,
      this.timestamp(),
    );
  }

  createLink(childNodeId: Id): Link {
    const id = this.insert(
      "INSERT INTO links_v9(child_inode_id,created_at) VALUES(?,?)",
      childNodeId,
      this.timestamp(),
    );
    return this.getLink(id);
  }

  getLink(id: Id): Link {
    const row = this.one("SELECT * FROM links_v9 WHERE id=?", id);
    if (row === null) throw new RepositoryError("not_found", "link not found");
    return {
      id: this.id(row.id),
      childNodeId: this.id(row.child_inode_id),
      createdAt: String(row.created_at),
    };
  }

  getInode(id: Id): Inode {
    const row = this.one("SELECT * FROM inodes_v9 WHERE id=?", id);
    if (row === null) throw new RepositoryError("not_found", "inode not found");
    return {
      id: this.id(row.id),
      ownerUserId: String(row.owner_user_id),
      groupId: row.group_id === null ? null : String(row.group_id),
      access: { content: Number(row.content_access), topology: Number(row.topology_access) },
      createdAt: String(row.created_at),
    };
  }

  updateInodeAccess(id: Id, access: Access, groupId: string | null): void {
    this.db.prepare("UPDATE inodes_v9 SET content_access=?,topology_access=?,group_id=? WHERE id=?")
      .run(access.content, access.topology, groupId, id);
  }

  insertNodeRecord(nodeId: Id, attributes: WorkFields): NodeRecord {
    const createdAt = this.timestamp();
    const payloadId = this.insert(
      "INSERT INTO payload_records_v9(work_json,created_at) VALUES(?,?)",
      JSON.stringify(WorkFieldsSchema.parse(attributes)),
      createdAt,
    );
    const id = this.insert(
      "INSERT INTO node_records_v9(inode_id,payload_record_id,created_at) VALUES(?,?,?)",
      nodeId,
      payloadId,
      createdAt,
    );
    return { id, nodeId, sessionId: "", revision: 0, attributes: WorkFieldsSchema.parse(attributes), createdAt };
  }

  getNodeRecord(id: Id): NodeRecord {
    const row = this.one("SELECT id,inode_id,payload_record_id,created_at FROM node_records_v9 WHERE id=?", id);
    if (row === null) throw new RepositoryError("not_found", "node record not found");
    return this.nodeRecord(row, null);
  }

  resolveNodeRecord(nodeId: Id, view: View): NodeRecord {
    const overlay = this.overlayFor(view, "inode", nodeId);
    if (overlay !== null) {
      const record = this.getNodeRecord(overlay.candidateRecordId);
      return { ...record, sessionId: overlay.sessionId, revision: overlay.overlayRevision };
    }
    const published = this.resolvePublishedNode(nodeId, view);
    const record = this.getNodeRecord(published.recordId);
    return { ...record, sessionId: String(published.branchId), revision: published.revision };
  }

  firstNodeChangeAfter(nodeId: Id, sessionId: string, revision: number): NodeRecord | null {
    const branchId = this.getSession(sessionId).branchId;
    const row = this.one(
      "SELECT record_id,revision FROM published_node_refs_v9 WHERE branch_id=? AND inode_id=? AND revision>? ORDER BY revision LIMIT 1",
      branchId,
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
      "INSERT INTO link_records_v9(link_id,parent_inode_id,name,created_at) VALUES(?,?,?,?)",
      linkId,
      parentNodeId,
      name,
      createdAt,
    );
    return { id, linkId, sessionId: "", revision: 0, parentNodeId, name, createdAt };
  }

  resolveLinkRecord(linkId: Id, view: View): LinkRecord {
    const overlay = this.overlayFor(view, "link", linkId);
    if (overlay !== null) {
      const record = this.getLinkRecord(overlay.candidateRecordId);
      return { ...record, sessionId: overlay.sessionId, revision: overlay.overlayRevision };
    }
    const published = this.resolvePublishedLink(linkId, view);
    const record = this.getLinkRecord(published.recordId);
    return { ...record, sessionId: String(published.branchId), revision: published.revision };
  }

  firstLinkChangeAfter(linkId: Id, sessionId: string, revision: number): LinkRecord | null {
    const row = this.one(
      "SELECT record_id,revision FROM published_link_refs_v9 WHERE branch_id=? AND link_id=? AND revision>? ORDER BY revision LIMIT 1",
      this.getSession(sessionId).branchId,
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
    let branchId = view.branchId;
    let revision = view.revision;

    while (true) {
      const span = this.spanAt(branchId, revision);
      const candidates = this.parentLinkCandidates(branchId, span.firstRevision, revision, parentNodeId);

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
          sessionId: String(candidate.branchId),
          revision: candidate.revision,
          childNodeId: stable.childNodeId,
        });
      }

      if (span.sourceBranchId === null || span.sourceRevision === null) break;
      branchId = span.sourceBranchId;
      revision = span.sourceRevision;
    }

    const links = [...selected.values()]
      .filter((link): link is EffectiveLink => link !== null)
      .map((link) => {
        const overlay = this.overlayFor(view, "link", link.linkId);
        if (overlay === null) return link;
        const record = this.getLinkRecord(overlay.candidateRecordId);
        if (record.parentNodeId !== parentNodeId) return null;
        return { ...record, sessionId: overlay.sessionId, revision: overlay.overlayRevision, childNodeId: link.childNodeId };
      })
      .filter((link): link is EffectiveLink => link !== null);

    if (view.overlaySessionId !== null) {
      for (const overlay of this.listLatestLinkOverlays(view.overlaySessionId, view.overlayHeadRevision, parentNodeId)) {
        if (links.some((link) => link.linkId === overlay.subjectId)) continue;
        const record = this.getLinkRecord(overlay.candidateRecordId);
        const stable = this.getLink(record.linkId);
        links.push({ ...record, sessionId: overlay.sessionId, revision: overlay.overlayRevision, childNodeId: stable.childNodeId });
      }
    }

    return links.sort((left, right) => left.name.localeCompare(right.name) || left.linkId - right.linkId);
  }

  reserveNextRevision(branchId: Id): number {
    const row = this.one("SELECT head_revision FROM branches_v9 WHERE id=?", branchId);
    if (row === null) throw new RepositoryError("not_found", "branch not found");
    const revision = Number(row.head_revision) + 1;
    this.db.prepare("INSERT INTO branch_revisions_v9(branch_id,revision,created_at) VALUES(?,?,?)")
      .run(branchId, revision, this.timestamp());
    return revision;
  }

  publishReferences(
    branchId: Id,
    revision: number,
    nodeRecords: readonly NodeRecord[],
    linkRecords: readonly { record: LinkRecord; previousParentNodeId: Id | null }[],
  ): void {
    for (const record of nodeRecords) {
      this.db.prepare(
        "INSERT INTO published_node_refs_v9(branch_id,inode_id,revision,record_id) VALUES(?,?,?,?)",
      ).run(branchId, record.nodeId, revision, record.id);
    }

    for (const reference of linkRecords) {
      this.db.prepare(
        "INSERT INTO published_link_refs_v9(branch_id,link_id,revision,record_id,parent_inode_id,previous_parent_inode_id) VALUES(?,?,?,?,?,?)",
      ).run(
        branchId,
        reference.record.linkId,
        revision,
        reference.record.id,
        reference.record.parentNodeId,
        reference.previousParentNodeId,
      );
    }
  }

  insertSpan(branchId: Id, firstRevision: number, source: View | null): void {
    this.db.prepare(
      "INSERT INTO branch_spans_v9(branch_id,first_revision,source_branch_id,source_revision) VALUES(?,?,?,?)",
    ).run(branchId, firstRevision, source?.branchId ?? null, source?.revision ?? null);
  }

  getSessionRevision(sessionId: string, revision: number): SessionRevision {
    const session = this.getSession(sessionId);
    const row = this.one(
      "SELECT created_at FROM branch_revisions_v9 WHERE branch_id=? AND revision=?",
      session.branchId,
      revision,
    );
    if (row === null) throw new RepositoryError("not_found", "session revision not found: r" + revision);
    return {
      sessionId,
      branchId: session.branchId,
      revision,
      rootNodeId: session.rootNodeId,
      overlaySessionId: null,
      overlayHeadRevision: 0,
      createdAt: String(row.created_at),
    };
  }

  listSessionRevisions(sessionId: string): SessionRevision[] {
    const session = this.getSession(sessionId);
    return this.all("SELECT revision,created_at FROM branch_revisions_v9 WHERE branch_id=? ORDER BY revision", session.branchId)
      .map((row) => ({
        sessionId,
        branchId: session.branchId,
        revision: Number(row.revision),
        rootNodeId: session.rootNodeId,
        overlaySessionId: null,
        overlayHeadRevision: 0,
        createdAt: String(row.created_at),
      }));
  }

  appendEvent(sessionId: string, revision: number | null, event: SessionEventDocument): void {
    const document = SessionEventDocumentSchema.parse(event);
    this.db.prepare("INSERT INTO session_events_v9(session_id,branch_id,revision,event_json) VALUES(?,?,?,?)")
      .run(sessionId, this.getSession(sessionId).branchId, revision, JSON.stringify(document));
  }

  insertProposal(proposal: NewProposal): Proposal {
    const id = this.insert(
      "INSERT INTO proposals_v9(session_id,source_session_id,source_revision,target_node_id,base_record_id,patch_json,kind,status,created_at,decided_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
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
    return this.all("SELECT * FROM proposals_v9 WHERE session_id=? AND status='pending' ORDER BY created_at", sessionId)
      .map((row) => this.proposal(row));
  }

  getPendingProposal(id: Id, sessionId: string): Proposal {
    const row = this.one("SELECT * FROM proposals_v9 WHERE id=? AND session_id=? AND status='pending'", id, sessionId);
    if (row === null) throw new RepositoryError("not_found", "pending proposal not found");
    return this.proposal(row);
  }

  updateProposalStatus(id: Id, status: ProposalStatus): void {
    this.db.prepare("UPDATE proposals_v9 SET status=?,decided_at=? WHERE id=?")
      .run(status, this.timestamp(), id);
  }

  findReceipt(sessionId: string, key: string): JsonValue | null {
    const row = this.one("SELECT result_json FROM receipts_v9 WHERE session_id=? AND idempotency_key=?", sessionId, key);
    return row === null ? null : JsonSchema.parse(JSON.parse(String(row.result_json)));
  }

  saveReceipt(sessionId: string, key: string, result: unknown): void {
    this.db.prepare("INSERT INTO receipts_v9(session_id,idempotency_key,result_json,created_at) VALUES(?,?,?,?)")
      .run(sessionId, key, JSON.stringify(JsonSchema.parse(result)), this.timestamp());
  }

  appendOverlay(overlay: Overlay): void {
    this.db.prepare(
      "INSERT INTO session_overlays_v9(session_id,subject_kind,subject_id,overlay_revision,base_branch_id,base_branch_revision,base_record_id,candidate_record_id,parent_inode_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      overlay.sessionId, overlay.subjectKind, overlay.subjectId, overlay.overlayRevision,
      overlay.baseBranchId, overlay.baseBranchRevision, overlay.baseRecordId,
      overlay.candidateRecordId, overlay.parentNodeId, overlay.createdAt,
    );
    this.db.prepare("UPDATE sessions_v9 SET overlay_head_revision=?,updated_at=? WHERE id=?")
      .run(overlay.overlayRevision, this.timestamp(), overlay.sessionId);
  }

  latestOverlay(sessionId: string, subjectKind: OverlaySubject, subjectId: Id, head: number): Overlay | null {
    const row = this.one(
      "SELECT * FROM session_overlays_v9 WHERE session_id=? AND subject_kind=? AND subject_id=? AND overlay_revision<=? ORDER BY overlay_revision DESC LIMIT 1",
      sessionId, subjectKind, subjectId, head,
    );
    return row === null ? null : this.overlay(row);
  }

  listLatestLinkOverlays(sessionId: string, head: number, parentNodeId: Id): Overlay[] {
    const rows = this.all(
      "SELECT * FROM session_overlays_v9 WHERE session_id=? AND subject_kind='link' AND parent_inode_id=? AND overlay_revision<=? ORDER BY overlay_revision DESC",
      sessionId,
      parentNodeId,
      head,
    );
    const seen = new Set<Id>();
    return rows.filter((row) => {
      const subjectId = this.id(row.subject_id);
      if (seen.has(subjectId)) return false;
      seen.add(subjectId);
      return true;
    }).map((row) => this.overlay(row));
  }

  publishMailbox(entry: MailboxEntry): void {
    this.db.prepare(
      "INSERT INTO mailbox_v9(authority_inode_id,subject_kind,subject_id,author_session_id,published_overlay_revision,base_branch_id,base_branch_revision,base_record_id,candidate_record_id,published_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(authority_inode_id,subject_kind,subject_id,author_session_id) DO UPDATE SET published_overlay_revision=excluded.published_overlay_revision,base_branch_id=excluded.base_branch_id,base_branch_revision=excluded.base_branch_revision,base_record_id=excluded.base_record_id,candidate_record_id=excluded.candidate_record_id,published_at=excluded.published_at",
    ).run(
      entry.authorityInodeId, entry.subjectKind, entry.subjectId, entry.authorSessionId,
      entry.publishedOverlayRevision, entry.baseBranchId, entry.baseBranchRevision,
      entry.baseRecordId, entry.candidateRecordId, entry.publishedAt,
    );
  }

  getMailbox(authorityInodeId: Id, subjectKind: OverlaySubject, subjectId: Id, authorSessionId: string): MailboxEntry | null {
    const row = this.one(
      "SELECT * FROM mailbox_v9 WHERE authority_inode_id=? AND subject_kind=? AND subject_id=? AND author_session_id=?",
      authorityInodeId,
      subjectKind,
      subjectId,
      authorSessionId,
    );
    return row === null ? null : this.mailbox(row);
  }

  withdrawMailbox(authorityInodeId: Id, subjectKind: OverlaySubject, subjectId: Id, authorSessionId: string): void {
    this.db.prepare("DELETE FROM mailbox_v9 WHERE authority_inode_id=? AND subject_kind=? AND subject_id=? AND author_session_id=?")
      .run(authorityInodeId, subjectKind, subjectId, authorSessionId);
  }

  listMailbox(authorityOwnerUserId: string): MailboxEntry[] {
    return this.all(
      "SELECT m.* FROM mailbox_v9 m JOIN inodes_v9 i ON i.id=m.authority_inode_id WHERE i.owner_user_id=? ORDER BY m.published_at",
      authorityOwnerUserId,
    ).map((row) => this.mailbox(row));
  }

  private resolvePublishedNode(nodeId: Id, view: View): PublishedRecord {
    return this.resolvePublished("published_node_refs_v9", "inode_id", nodeId, view);
  }

  private resolvePublishedLink(linkId: Id, view: View): PublishedRecord {
    return this.resolvePublished("published_link_refs_v9", "link_id", linkId, view);
  }

  private resolvePublished(
    table: "published_node_refs_v9" | "published_link_refs_v9",
    identityColumn: "inode_id" | "link_id",
    identity: Id,
    view: View,
  ): PublishedRecord {
    let branchId = view.branchId;
    let revision = view.revision;

    while (true) {
      const span = this.spanAt(branchId, revision);
      const row = this.one(
        "SELECT record_id,revision FROM " + table + " WHERE branch_id=? AND " + identityColumn + "=? AND revision>=? AND revision<=? ORDER BY revision DESC LIMIT 1",
        branchId,
        identity,
        span.firstRevision,
        revision,
      );
      if (row !== null) {
        return { recordId: this.id(row.record_id), branchId, revision: Number(row.revision) };
      }
      if (span.sourceBranchId === null || span.sourceRevision === null) {
        throw new RepositoryError("not_found", "record did not exist in selected revision");
      }
      branchId = span.sourceBranchId;
      revision = span.sourceRevision;
    }
  }

  private spanAt(branchId: Id, revision: number): Span {
    const row = this.one(
      "SELECT * FROM branch_spans_v9 WHERE branch_id=? AND first_revision<=? ORDER BY first_revision DESC LIMIT 1",
      branchId,
      revision,
    );
    if (row === null) throw new RepositoryError("invariant", "session view has no resolution span");
    return {
      branchId: this.id(row.branch_id),
      firstRevision: Number(row.first_revision),
      sourceBranchId: row.source_branch_id === null ? null : this.id(row.source_branch_id),
      sourceRevision: row.source_revision === null ? null : Number(row.source_revision),
    };
  }

  private parentLinkCandidates(branchId: Id, firstRevision: number, revision: number, parentNodeId: Id): PublishedLinkRecord[] {
    const present = this.all(
      "SELECT link_id,record_id,revision FROM published_link_refs_v9 WHERE branch_id=? AND parent_inode_id=? AND revision>=? AND revision<=? ORDER BY revision DESC",
      branchId,
      parentNodeId,
      firstRevision,
      revision,
    );
    const removed = this.all(
      "SELECT link_id,record_id,revision FROM published_link_refs_v9 WHERE branch_id=? AND previous_parent_inode_id=? AND revision>=? AND revision<=? ORDER BY revision DESC",
      branchId,
      parentNodeId,
      firstRevision,
      revision,
    );
    return [...present, ...removed]
      .sort((left, right) => Number(right.revision) - Number(left.revision))
      .map((row) => ({ recordId: this.id(row.record_id), branchId, revision: Number(row.revision), linkId: this.id(row.link_id) }));
  }

  private getLinkRecord(id: Id): LinkRecord {
    const row = this.one("SELECT * FROM link_records_v9 WHERE id=?", id);
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
    const payload = this.one("SELECT work_json FROM payload_records_v9 WHERE id=?", this.id(row.payload_record_id));
    if (payload === null) throw new RepositoryError("invariant", "node record is missing its payload");
    return {
      id: this.id(row.id),
      nodeId: this.id(row.inode_id),
      sessionId: publication?.branchId === undefined ? "" : String(publication.branchId),
      revision: publication?.revision ?? 0,
      attributes: this.json(WorkFieldsSchema, payload.work_json),
      createdAt: String(row.created_at),
    };
  }

  private getProposal(id: Id): Proposal {
    const row = this.one("SELECT * FROM proposals_v9 WHERE id=?", id);
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

  private overlay(row: Row): Overlay {
    return {
      sessionId: String(row.session_id),
      subjectKind: z.enum(["inode", "link"]).parse(row.subject_kind),
      subjectId: this.id(row.subject_id),
      overlayRevision: Number(row.overlay_revision),
      baseBranchId: this.id(row.base_branch_id),
      baseBranchRevision: Number(row.base_branch_revision),
      baseRecordId: this.id(row.base_record_id),
      candidateRecordId: this.id(row.candidate_record_id),
      parentNodeId: row.parent_inode_id === null ? null : this.id(row.parent_inode_id),
      createdAt: String(row.created_at),
    };
  }

  private mailbox(row: Row): MailboxEntry {
    return {
      authorityInodeId: this.id(row.authority_inode_id),
      subjectKind: z.enum(["inode", "link"]).parse(row.subject_kind),
      subjectId: this.id(row.subject_id),
      authorSessionId: String(row.author_session_id),
      publishedOverlayRevision: Number(row.published_overlay_revision),
      baseBranchId: this.id(row.base_branch_id),
      baseBranchRevision: Number(row.base_branch_revision),
      baseRecordId: this.id(row.base_record_id),
      candidateRecordId: this.id(row.candidate_record_id),
      publishedAt: String(row.published_at),
    };
  }

  private session(row: Row): Session {
    const branchId = row.current_branch_id === null ? 0 : this.id(row.current_branch_id);
    const branch = branchId === 0 ? null : this.one("SELECT * FROM branches_v9 WHERE id=?", branchId);
    const filesystem = row.filesystem_id === null ? null : this.one("SELECT * FROM filesystems_v9 WHERE id=?", this.id(row.filesystem_id));
    return {
      id: String(row.id),
      userId: String(row.user_id),
      groups: this.json(z.array(z.string()), row.groups_json),
      metadata: this.json(z.record(z.string(), JsonSchema), row.metadata_json),
      workspacePath: filesystem === null ? "" : String(filesystem.workspace_path),
      rootNodeId: filesystem === null ? 0 : this.id(filesystem.root_inode_id),
      branchId,
      headRevision: branch === null ? -1 : Number(branch.head_revision),
      headRevisionCreatedAt: branch === null ? String(row.created_at) : String(branch.head_revision_created_at),
      cursorLinkPath: this.json(z.array(IdSchema), row.cursor_link_path_json),
      overlayHeadRevision: Number(row.overlay_head_revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private overlayFor(view: View, subjectKind: OverlaySubject, subjectId: Id): Overlay | null {
    if (view.overlaySessionId === null) return null;
    return this.latestOverlay(view.overlaySessionId, subjectKind, subjectId, view.overlayHeadRevision);
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
