import { z } from "zod";
import { ContinuationModel, type ResolvedNode, type ResolvedSession } from "./continuation-model.js";
import { RepositoryError, SqliteRecordRepository, type RecordRepository } from "./record-repository.js";
import { writeDiagnostic } from "./diagnostics.js";
import {
  OperationSchemas,
  PROTOCOL_VERSION,
  schemaDigest,
  type BriefingResult,
  type CurrentDirectory,
  type CursorState,
  type EntrySummary,
  type Id,
  type NodeRevisionSummary,
  type OperationName,
  type ProposalSummary,
  type PwdState,
  type RpcResponse,
  type WorkPatch,
  JsonSchema,
} from "./schema.js";

type Mutation = { rootNodeRevisionId: Id; cursorEntryPath: Id[] };

/** Transactional controller for the filesystem use cases. */
export class ContinuationController {
  private readonly model: ContinuationModel;

  constructor(private readonly records: RecordRepository = new SqliteRecordRepository()) {
    this.model = new ContinuationModel(records);
  }

  describe() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      schemaDigest,
      operations: Object.entries(OperationSchemas).map(([name, operation]) => ({
        name,
        inputSchema: JsonSchema.parse(z.toJSONSchema(operation.input)),
        outputSchema: JsonSchema.parse(z.toJSONSchema(operation.output)),
      })),
    };
  }

  dispatch(name: OperationName, raw: unknown, idempotencyKey?: string): unknown {
    const started = Date.now();
    const sessionId = this.sessionIdFrom(raw);
    const before = this.diagnosticState(sessionId);
    const replay = sessionId && idempotencyKey
      ? this.records.findReceipt(sessionId, idempotencyKey) !== undefined
      : false;
    try {
      const result = OperationSchemas[name].output.parse(this.dispatchValidated(name, raw, idempotencyKey));
      this.diagnostic(sessionId, name, idempotencyKey, replay ? "replay" : "result", started, before, result);
      return result;
    } catch (error) {
      this.diagnostic(sessionId, name, idempotencyKey, "error", started, before, undefined, error);
      throw error;
    }
  }

  failure(id: string, error: unknown): RpcResponse {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof RepositoryError ? error.code
      : error instanceof z.ZodError ? "validation"
      : message.includes("schema digest") ? "unsupported_protocol" : "internal";
    return { protocolVersion: PROTOCOL_VERSION, id, ok: false, error: { code, message } };
  }

  private dispatchValidated(name: OperationName, raw: unknown, key?: string): unknown {
    switch (name) {
      case "hello": return this.hello(raw);
      case "describe": OperationSchemas.describe.input.parse(raw); return this.describe();
      case "pwd": return this.pwd(raw, key);
      case "ls": return this.ls(raw);
      case "cd": return this.cd(raw, key);
      case "mkdir": return this.mkdir(raw, key);
      case "edit": return this.edit(raw, key);
      case "mv": return this.move(raw, key);
      case "close": return this.close(raw, key);
      case "search": return this.search(raw);
      case "rev-list": return this.revisionList(raw);
      case "rev-show": return this.revisionShow(raw);
      case "fork": return this.fork(raw, key);
      case "briefing": return this.briefing(raw);
      case "proposals": return this.proposals(raw);
      case "decide-proposal": return this.decideProposal(raw, key);
      case "submit-proposal": return this.submitProposal(raw, key);
    }
  }

  private hello(raw: unknown) {
    const input = OperationSchemas.hello.input.parse(raw);
    if (input.schemaDigest !== schemaDigest) throw new Error("schema digest mismatch");
    return { protocolVersion: PROTOCOL_VERSION, schemaDigest, daemon: "context-tree-v3" };
  }

  private pwd(raw: unknown, key?: string): PwdState {
    const input = OperationSchemas.pwd.input.parse(raw);
    return this.command(input.sessionId, key, () => {
      const existing = this.records.findSession(input.sessionId);
      if (existing) {
        if (input.cwd) this.model.validateWorkspace(existing, input.cwd);
        return this.pwdState(this.model.resolveSession(input.sessionId));
      }
      const resolved = this.model.createSession(input.sessionId, input.cwd ?? process.cwd());
      this.records.appendJournal({ sessionId: input.sessionId, operation: "pwd", previousSnapshotId: null, nextSnapshotId: resolved.snapshot.id, cursorEntryPath: [], idempotencyKey: key, payload: {} });
      return this.pwdState(resolved);
    });
  }

  private ls(raw: unknown) {
    const input = OperationSchemas.ls.input.parse(raw);
    const resolved = this.model.resolveSession(input.sessionId);
    const listed = this.model.resolvePath(resolved, input.path);
    return { ...this.cursorState(resolved), listedPath: this.model.path(listed), entries: this.entries(listed) };
  }

  private cd(raw: unknown, key?: string): CursorState {
    const input = OperationSchemas.cd.input.parse(raw);
    return this.mutation(input.sessionId, key, "cd", (resolved) => this.model.cd(resolved, input.path));
  }

  private mkdir(raw: unknown, key?: string): CursorState {
    const input = OperationSchemas.mkdir.input.parse(raw);
    return this.mutation(input.sessionId, key, "mkdir", (resolved) => this.model.mkdir(resolved, input.name, input.work));
  }

  private edit(raw: unknown, key?: string): CursorState {
    const input = OperationSchemas.edit.input.parse(raw);
    return this.mutation(input.sessionId, key, "edit", (resolved) => this.model.edit(resolved, input.patch));
  }

  private move(raw: unknown, key?: string): CursorState {
    const input = OperationSchemas.mv.input.parse(raw);
    return this.mutation(input.sessionId, key, "mv", (resolved) => this.model.move(resolved, input.source, input.destination));
  }

  private close(raw: unknown, key?: string): CursorState {
    const input = OperationSchemas.close.input.parse(raw);
    return this.mutation(input.sessionId, key, "close", (resolved) => this.model.close(resolved, input.summary, input.status));
  }

  private search(raw: unknown) {
    const input = OperationSchemas.search.input.parse(raw);
    const resolved = this.model.resolveSession(input.sessionId);
    const target = this.model.resolvePath(resolved, input.path);
    const needle = input.query.toLocaleLowerCase();
    const candidates = input.scope === "subtree"
      ? this.model.allNodesBelow(target)
      : this.searchRoots(resolved, input.scope).flatMap((root) => this.model.allNodesAt(root));
    const matches = candidates
      .filter((node) => this.searchable(node).includes(needle))
      .map((node) => ({ path: this.model.path(node), name: node.names.at(-1) ?? "/", work: this.model.work(node.payload) }));
    return { ...this.cursorState(resolved), matches };
  }

  private revisionList(raw: unknown) {
    const input = OperationSchemas["rev-list"].input.parse(raw);
    const resolved = this.model.resolveSession(input.sessionId);
    const target = this.model.resolvePath(resolved, input.path);
    return { ...this.cursorState(resolved), revisions: this.model.listNodeRevisions(target).map((revision) => this.revisionSummary(revision.id)) };
  }

  private revisionShow(raw: unknown) {
    const input = OperationSchemas["rev-show"].input.parse(raw);
    const resolved = this.model.resolveSession(input.sessionId);
    const target = this.model.resolvePath(resolved, input.path);
    const revision = this.model.revisionOnLineage(target, input.revisionId);
    return { ...this.cursorState(resolved), details: { revision: this.revisionSummary(revision.id), work: this.model.work(this.records.getPayloadRevision(revision.payloadRevisionId)), entries: this.entriesForRevision(revision.id) } };
  }

  private fork(raw: unknown, key?: string) {
    const input = OperationSchemas.fork.input.parse(raw);
    return this.command(input.sessionId, key, () => {
      const before = this.model.resolveSession(input.sessionId);
      const forked = this.model.fork(before, input.newSessionId);
      this.records.appendJournal({ sessionId: input.sessionId, operation: "fork", previousSnapshotId: before.snapshot.id, nextSnapshotId: before.snapshot.id, cursorEntryPath: before.cursor.entryPath, idempotencyKey: key, payload: { forkedSessionId: input.newSessionId } });
      return { ...this.cursorState(before), forkedSessionId: forked.session.id };
    });
  }

  private briefing(raw: unknown): BriefingResult {
    const input = OperationSchemas.briefing.input.parse(raw);
    const resolved = this.model.resolveSession(input.sessionId);
    return {
      ...this.cursorState(resolved),
      ancestry: resolved.nodes.map((node) => ({ path: this.model.path(node), work: this.model.work(node.payload), closedChildOutcomes: this.entries(node).filter((entry) => ["done", "abandoned", "superseded"].includes(entry.status)).map((entry) => entry.title || entry.name) })),
      pendingProposalCount: this.records.listPendingProposals(input.sessionId).length,
      unresolvedCount: this.model.countUnresolved(resolved),
    };
  }

  private proposals(raw: unknown) {
    const input = OperationSchemas.proposals.input.parse(raw);
    const resolved = this.model.resolveSession(input.sessionId);
    return { ...this.cursorState(resolved), proposals: this.records.listPendingProposals(input.sessionId).map((proposal) => this.proposal(proposal)) };
  }

  private decideProposal(raw: unknown, key?: string) {
    const input = OperationSchemas["decide-proposal"].input.parse(raw);
    return this.command(input.sessionId, key, () => {
      const resolved = this.model.resolveSession(input.sessionId);
      const proposal = this.records.getPendingProposal(input.proposalId, input.sessionId);
      const decision = this.model.decideProposal(resolved, proposal, input.decision, input.replacement);
      this.records.updateProposalStatus(proposal.id, decision.status);
      const next = decision.rootNodeRevisionId === undefined
        ? resolved
        : this.persistMutation(resolved, "decide-proposal", key, {
          rootNodeRevisionId: decision.rootNodeRevisionId,
          cursorEntryPath: decision.cursorEntryPath,
        });
      if (decision.rootNodeRevisionId === undefined) this.records.appendJournal({ sessionId: input.sessionId, operation: "decide-proposal", previousSnapshotId: resolved.snapshot.id, nextSnapshotId: resolved.snapshot.id, cursorEntryPath: resolved.cursor.entryPath, idempotencyKey: key, payload: { proposalId: proposal.id, status: decision.status } });
      return { ...this.cursorState(next), proposalId: proposal.id, status: decision.status };
    });
  }

  private submitProposal(raw: unknown, key?: string): ProposalSummary {
    const input = OperationSchemas["submit-proposal"].input.parse(raw);
    return this.command(input.sessionId, key, () => {
      const resolved = this.model.resolveSession(input.sessionId);
      const proposal = this.model.createProposal(resolved, input.kind, input.patch, input.sourceSessionId);
      this.records.appendJournal({ sessionId: input.sessionId, operation: "submit-proposal", previousSnapshotId: resolved.snapshot.id, nextSnapshotId: resolved.snapshot.id, cursorEntryPath: resolved.cursor.entryPath, idempotencyKey: key, payload: { proposalId: proposal.id } });
      return this.proposal(proposal);
    });
  }

  private mutation(sessionId: string, key: string | undefined, operation: string, change: (resolved: ResolvedSession) => Mutation): CursorState {
    return this.command(sessionId, key, () => {
      const resolved = this.model.resolveSession(sessionId);
      return this.cursorState(this.persistMutation(resolved, operation, key, change(resolved)));
    });
  }

  private command<T>(sessionId: string, key: string | undefined, work: () => T): T {
    return this.records.transaction(() => {
      if (key) {
        const replay = this.records.findReceipt(sessionId, key);
        if (replay !== undefined) return replay as T;
      }
      const result = work();
      if (key) this.records.saveReceipt(sessionId, key, result);
      return result;
    });
  }

  private persistMutation(resolved: ResolvedSession, operation: string, key: string | undefined, mutation: Mutation): ResolvedSession {
    const changed = mutation.rootNodeRevisionId !== resolved.snapshot.rootNodeRevisionId;
    const snapshot = changed ? this.records.insertSnapshot(mutation.rootNodeRevisionId, resolved.snapshot.id) : resolved.snapshot;
    if (changed) this.records.updateSessionHead(resolved.session.id, snapshot.id);
    this.records.saveCursor({ sessionId: resolved.session.id, snapshotId: snapshot.id, entryPath: mutation.cursorEntryPath, updatedAt: new Date().toISOString() });
    this.records.appendJournal({ sessionId: resolved.session.id, operation, previousSnapshotId: resolved.snapshot.id, nextSnapshotId: snapshot.id, cursorEntryPath: mutation.cursorEntryPath, idempotencyKey: key, payload: {} });
    return this.model.resolveSession(resolved.session.id);
  }

  private cursorState(resolved: ResolvedSession): CursorState {
    const current = this.model.current(resolved);
    const current_dir: CurrentDirectory = { path: this.model.path(current), canGoBack: current.entryPath.length > 0 };
    return { current_dir };
  }

  private pwdState(resolved: ResolvedSession): PwdState {
    const current = this.model.current(resolved);
    return {
      ...this.cursorState(resolved),
      current_work: this.model.work(current.payload),
    };
  }

  private entries(node: ResolvedNode): EntrySummary[] {
    return this.model.entrySummaries(node).map(({ name, child }) => ({ name, kind: child.payload.kind, title: child.payload.title, status: child.payload.status, hasChildren: child.memberships.length > 0 }));
  }

  private entriesForRevision(revisionId: Id): EntrySummary[] {
    const revision = this.records.getNodeRevision(revisionId);
    const directory = this.records.getDirectoryRevision(revision.directoryRevisionId);
    return this.records.listMemberships(directory.id).map((membership) => {
      const entry = this.records.getEntryRevision(membership.entryRevisionId);
      const child = this.records.getNodeRevision(membership.childNodeRevisionId);
      const work = this.records.getPayloadRevision(child.payloadRevisionId);
      return { name: entry.name, kind: work.kind, title: work.title, status: work.status, hasChildren: this.records.listMemberships(child.directoryRevisionId).length > 0 };
    });
  }

  private revisionSummary(revisionId: Id): NodeRevisionSummary {
    const revision = this.records.getNodeRevision(revisionId);
    return { revisionId: revision.id, createdAt: revision.createdAt, changes: this.model.changes(revision) };
  }

  private proposal(proposal: { id: Id; kind: ProposalSummary["kind"]; status: ProposalSummary["status"]; createdAt: string; sourceSessionId: string | null; patch: WorkPatch | null }): ProposalSummary {
    return { proposalId: proposal.id, kind: proposal.kind, status: proposal.status, createdAt: proposal.createdAt, sourceSessionId: proposal.sourceSessionId, patch: proposal.patch };
  }

  private searchable(node: ResolvedNode): string {
    const work = this.model.work(node.payload);
    return [this.model.path(node), work.kind, work.title, work.objective, work.rationale, work.currentState].join("\n").toLocaleLowerCase();
  }

  private searchRoots(resolved: ResolvedSession, scope: "subtree" | "session" | "workspace" | "global" | "history"): Id[] {
    switch (scope) {
      case "subtree": return [this.model.current(resolved).nodeRevision.id];
      case "session": return [resolved.snapshot.rootNodeRevisionId];
      case "workspace": return this.records.listSessionHeadSnapshotIds(resolved.session.workspaceId)
        .map((snapshotId) => this.records.getSnapshot(snapshotId).rootNodeRevisionId);
      case "global": return this.records.listSessionHeadSnapshotIds()
        .map((snapshotId) => this.records.getSnapshot(snapshotId).rootNodeRevisionId);
      case "history": return this.records.listHistoricalSnapshotRootRevisionIds();
    }
  }

  private sessionIdFrom(raw: unknown): string | undefined {
    const parsed = z.object({ sessionId: z.string() }).passthrough().safeParse(raw);
    return parsed.success ? parsed.data.sessionId : undefined;
  }

  private diagnostic(
    sessionId: string | undefined,
    operation: string,
    idempotencyKey: string | undefined,
    outcome: "result" | "replay" | "error",
    started: number,
    before: { headSnapshotId?: Id; cursorDepth?: number; currentNodeRevisionId?: Id },
    result?: unknown,
    error?: unknown,
  ): void {
    const after = this.diagnosticState(sessionId);
    const base = {
      sessionId,
      operation,
      idempotencyKey,
      outcome,
      durationMs: Date.now() - started,
      beforeSnapshotId: before.headSnapshotId,
      afterSnapshotId: after.headSnapshotId,
      beforeNodeRevisionId: before.currentNodeRevisionId,
      afterNodeRevisionId: after.currentNodeRevisionId,
      cursorDepthBefore: before.cursorDepth,
      cursorDepthAfter: after.cursorDepth,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    };
    if (process.env.CONTEXT_TREE_DEBUG_CONTEXT === "1") {
      writeDiagnostic({ ...base, result });
      return;
    }
    writeDiagnostic(base);
  }

  private diagnosticState(sessionId: string | undefined): {
    headSnapshotId?: Id;
    cursorDepth?: number;
    currentNodeRevisionId?: Id;
  } {
    if (!sessionId) return {};
    const session = this.records.findSession(sessionId);
    if (!session) return {};
    try {
      const resolved = this.model.resolveSession(sessionId);
      return {
        headSnapshotId: session.headSnapshotId,
        cursorDepth: resolved.cursor.entryPath.length,
        currentNodeRevisionId: this.model.current(resolved).nodeRevision.id,
      };
    } catch {
      return { headSnapshotId: session.headSnapshotId };
    }
  }
}

/**
 * Transport-facing filesystem facade. It intentionally exposes no repository,
 * snapshot, or model API: daemon, MCP, hook, and shell adapters see only this
 * cursor-relative operation surface.
 */
export class FilesystemOperations {
  constructor(private readonly controller = new ContinuationController()) {}

  describe() {
    return this.controller.describe();
  }

  dispatch(name: OperationName, raw: unknown, idempotencyKey?: string): unknown {
    return this.controller.dispatch(name, raw, idempotencyKey);
  }

  failure(id: string, error: unknown): RpcResponse {
    return this.controller.failure(id, error);
  }
}
