import { z } from "zod";
import { parseCommand } from "./commands.js";
import { ContinuationModel, type ResolvedNode, type ResolvedSession, type StateMutation } from "./continuation-model.js";
import { RepositoryError, SqliteRecordRepository, type Proposal, type RecordRepository, type SessionRevision, type View } from "./record-repository.js";
import { writeDiagnostic } from "./diagnostics.js";
import {
  CommandInputSchema,
  OperationSchemas,
  PROTOCOL_VERSION,
  schemaDigest,
  type BriefingResult,
  type CurrentDirectory,
  type CursorState,
  type EntrySummary,
  type Id,
  type ProposalSummary,
  type PwdState,
  type RevisionSummary,
  type RpcResponse,
  type SearchMatch,
  type WorkPatch,
} from "./schema.js";

/** Transactional controller for the public filesystem use cases. */
export class ContinuationController {
  private readonly model: ContinuationModel;

  constructor(private readonly records: RecordRepository = new SqliteRecordRepository()) {
    this.model = new ContinuationModel(records);
  }

  execute(raw: unknown, idempotencyKey?: string): unknown {
    const input = CommandInputSchema.parse(raw);
    const parsed = parseCommand(input);
    if (parsed.kind === "help") return parsed.result;
    return this.dispatch(parsed.name, parsed.input, idempotencyKey);
  }

  dispatch(name: keyof typeof OperationSchemas, raw: unknown, idempotencyKey?: string): unknown {
    const started = Date.now();
    const sessionId = this.sessionIdFrom(raw);
    const key = idempotencyKey ?? null;
    const before = this.diagnosticState(sessionId);
    const replay = sessionId !== null && key !== null && this.records.findReceipt(sessionId, key) !== null;
    try {
      const result = OperationSchemas[name].output.parse(this.dispatchValidated(name, raw, key));
      this.diagnostic(sessionId, name, key, replay ? "replay" : "result", started, before, result);
      return result;
    } catch (error) {
      this.diagnostic(sessionId, name, key, "error", started, before, null, error);
      throw error;
    }
  }

  failure(id: string, error: unknown): RpcResponse {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof RepositoryError
      ? error.code
      : error instanceof z.ZodError
        ? "validation"
        : message.includes("schema digest")
          ? "unsupported_protocol"
          : "internal";
    return { protocolVersion: PROTOCOL_VERSION, id, ok: false, error: { code, message } };
  }

  private dispatchValidated(name: keyof typeof OperationSchemas, raw: unknown, key: string | null): unknown {
    switch (name) {
      case "hello": return this.hello(raw);
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
    return { protocolVersion: PROTOCOL_VERSION, schemaDigest, daemon: "context-tree-v6" };
  }

  private pwd(raw: unknown, key: string | null): PwdState {
    const input = OperationSchemas.pwd.input.parse(raw);
    return this.command(input.sessionId, key, OperationSchemas.pwd.output, () => {
      const existing = this.records.findSession(input.sessionId);
      if (existing) {
        if (input.cwd) this.model.validateWorkspace(existing, input.cwd);
        return this.pwdState(this.model.resolveSession(input.sessionId));
      }
      return this.pwdState(this.model.createSession(input.sessionId, input.cwd ?? process.cwd()));
    });
  }

  private ls(raw: unknown) {
    const input = OperationSchemas.ls.input.parse(raw);
    const live = this.model.resolveSession(input.sessionId);
    if (input.revision === undefined) {
      const listed = this.model.resolvePath(live, input.path ?? ".");
      return {
        ...this.cursorState(live),
        listedPath: this.model.path(listed),
        entries: this.entries(live.view, listed),
      };
    }
    const view = this.model.resolveView(
      input.sessionId,
      input.revision,
      input.reference,
      input.path ?? ".",
    );
    return {
      ...this.cursorState(live),
      listedPath: this.model.path(view.node),
      view_path: this.model.path(view.node),
      entries: this.entries(view.selected, view.node),
    };
  }

  private cd(raw: unknown, key: string | null): CursorState {
    const input = OperationSchemas.cd.input.parse(raw);
    return this.mutation(input.sessionId, key, "cd", OperationSchemas.cd.output, (resolved) =>
      this.model.cd(resolved, input.path)
    );
  }

  private mkdir(raw: unknown, key: string | null): CursorState {
    const input = OperationSchemas.mkdir.input.parse(raw);
    return this.mutation(input.sessionId, key, "mkdir", OperationSchemas.mkdir.output, (resolved, revision) =>
      this.model.mkdir(resolved, revision, input.name, input.work ?? {})
    );
  }

  private edit(raw: unknown, key: string | null): CursorState {
    const input = OperationSchemas.edit.input.parse(raw);
    return this.mutation(input.sessionId, key, "edit", OperationSchemas.edit.output, (resolved, revision) =>
      this.model.edit(resolved, revision, input.patch)
    );
  }

  private move(raw: unknown, key: string | null): CursorState {
    const input = OperationSchemas.mv.input.parse(raw);
    return this.mutation(input.sessionId, key, "mv", OperationSchemas.mv.output, (resolved, revision) =>
      this.model.move(resolved, revision, input.source, input.destination)
    );
  }

  private close(raw: unknown, key: string | null): CursorState {
    const input = OperationSchemas.close.input.parse(raw);
    return this.mutation(input.sessionId, key, "close", OperationSchemas.close.output, (resolved, revision) =>
      this.model.close(resolved, revision, input.summary, input.status)
    );
  }

  private search(raw: unknown) {
    const input = OperationSchemas.search.input.parse(raw);
    const resolved = this.model.resolveSession(input.sessionId);
    const needle = input.query.toLocaleLowerCase();
    const matches = input.scope === "history"
      ? this.historyMatches(input.sessionId, needle)
      : this.currentMatches(resolved, input.scope, input.path, needle);
    return { ...this.cursorState(resolved), matches };
  }

  private revisionList(raw: unknown) {
    const input = OperationSchemas["rev-list"].input.parse(raw);
    const resolved = this.model.resolveSession(input.sessionId);
    const revisions = this.model.history(input.sessionId, input.reference, input.path ?? ".")
      .map(({ revision, changes }) => this.revisionSummary(revision, changes));
    return { ...this.cursorState(resolved), head_revision: resolved.session.headRevision, revisions };
  }

  private revisionShow(raw: unknown) {
    const input = OperationSchemas["rev-show"].input.parse(raw);
    const resolved = this.model.resolveSession(input.sessionId);
    const view = this.model.resolveView(
      input.sessionId,
      input.revision,
      input.reference,
      input.path ?? ".",
    );
    const history = this.model.history(input.sessionId, input.reference, input.path ?? ".");
    const item = history.find((value) => value.revision.revision === input.revision);
    return {
      ...this.cursorState(resolved),
      details: {
        revision: this.revisionSummary(view.selected, item?.changes ?? []),
        view_path: this.model.path(view.node),
        work: this.model.work(view.node),
        entries: this.entries(view.selected, view.node),
      },
    };
  }

  private fork(raw: unknown, key: string | null) {
    const input = OperationSchemas.fork.input.parse(raw);
    return this.command(input.sessionId, key, OperationSchemas.fork.output, () => {
      const before = this.model.resolveSession(input.sessionId);
      const forked = this.model.fork(before, input.newSessionId);
      this.records.appendEvent({
        sessionId: input.sessionId,
        revision: null,
        rootNodeId: null,
        operation: "fork",
        cursorLinkPath: before.session.cursorLinkPath,
        idempotencyKey: key,
        payload: { forkedSessionId: input.newSessionId },
      });
      return { ...this.cursorState(before), forkedSessionId: forked.session.id };
    });
  }

  private briefing(raw: unknown): BriefingResult {
    const input = OperationSchemas.briefing.input.parse(raw);
    const resolved = this.model.resolveSession(input.sessionId);
    return {
      ...this.cursorState(resolved),
      ancestry: resolved.nodes.map((node) => ({
        path: this.model.path(node),
        work: this.model.work(node),
        closedChildOutcomes: this.entries(resolved.view, node)
          .filter((entry) => ["done", "abandoned", "superseded"].includes(entry.status))
          .map((entry) => entry.title || entry.name),
      })),
      pendingProposalCount: this.records.listPendingProposals(input.sessionId).length,
      unresolvedCount: this.model.allNodes(resolved)
        .filter((node) => !["done", "abandoned", "superseded"].includes(node.record.attributes.status))
        .length,
    };
  }

  private proposals(raw: unknown) {
    const input = OperationSchemas.proposals.input.parse(raw);
    const resolved = this.model.resolveSession(input.sessionId);
    return {
      ...this.cursorState(resolved),
      proposals: this.records.listPendingProposals(input.sessionId).map((proposal) => this.proposal(proposal)),
    };
  }

  private decideProposal(raw: unknown, key: string | null) {
    const input = OperationSchemas["decide-proposal"].input.parse(raw);
    return this.command(input.sessionId, key, OperationSchemas["decide-proposal"].output, () => {
      const resolved = this.model.resolveSession(input.sessionId);
      const proposal = this.records.getPendingProposal(input.proposalId, input.sessionId);
      const revision = resolved.session.headRevision + 1;
      const decision = this.model.decideProposal(resolved, revision, proposal, input.decision, input.replacement ?? null);
      this.records.updateProposalStatus(proposal.id, decision.status);
      const next = decision.kind === "state"
        ? this.persistMutation(resolved, "decide-proposal", key, decision.cursorLinkPath)
        : this.persistCursorOnly(resolved, "decide-proposal", key, decision.cursorLinkPath);
      return { ...this.cursorState(next), proposalId: proposal.id, status: decision.status };
    });
  }

  private submitProposal(raw: unknown, key: string | null): ProposalSummary {
    const input = OperationSchemas["submit-proposal"].input.parse(raw);
    return this.command(input.sessionId, key, OperationSchemas["submit-proposal"].output, () => {
      const resolved = this.model.resolveSession(input.sessionId);
      const proposal = this.model.createProposal(resolved, input.kind, input.patch ?? null, input.sourceSessionId ?? null);
      this.records.appendEvent({
        sessionId: input.sessionId,
        revision: null,
        rootNodeId: null,
        operation: "submit-proposal",
        cursorLinkPath: resolved.session.cursorLinkPath,
        idempotencyKey: key,
        payload: { proposalId: proposal.id },
      });
      return this.proposal(proposal);
    });
  }

  private mutation<T extends CursorState>(
    sessionId: string,
    key: string | null,
    operation: string,
    schema: z.ZodType<T>,
    change: (resolved: ResolvedSession, revision: number) => StateMutation,
  ): T {
    return this.command(sessionId, key, schema, () => {
      const resolved = this.model.resolveSession(sessionId);
      const revision = resolved.session.headRevision + 1;
      const mutation = change(resolved, revision);
      const next = mutation.changed
        ? this.persistMutation(resolved, operation, key, mutation.cursorLinkPath)
        : this.persistCursorOnly(resolved, operation, key, mutation.cursorLinkPath);
      return schema.parse(this.cursorState(next));
    });
  }

  private command<T>(sessionId: string, key: string | null, schema: z.ZodType<T>, work: () => T): T {
    return this.records.transaction(() => {
      if (key !== null) {
        const receipt = this.records.findReceipt(sessionId, key);
        if (receipt !== null) return schema.parse(receipt);
      }
      const result = schema.parse(work());
      if (key !== null) this.records.saveReceipt(sessionId, key, result);
      return result;
    });
  }

  private persistMutation(
    resolved: ResolvedSession,
    operation: string,
    key: string | null,
    cursorLinkPath: Id[],
  ): ResolvedSession {
    const revision = resolved.session.headRevision + 1;
    this.records.updateSessionHead(resolved.session.id, revision, cursorLinkPath);
    this.records.appendEvent({
      sessionId: resolved.session.id,
      revision,
      rootNodeId: resolved.view.rootNodeId,
      operation,
      cursorLinkPath,
      idempotencyKey: key,
      payload: {},
    });
    return this.model.resolveSession(resolved.session.id);
  }

  private persistCursorOnly(
    resolved: ResolvedSession,
    operation: string,
    key: string | null,
    cursorLinkPath: Id[],
  ): ResolvedSession {
    this.records.updateSessionCursor(resolved.session.id, cursorLinkPath);
    this.records.appendEvent({
      sessionId: resolved.session.id,
      revision: null,
      rootNodeId: null,
      operation,
      cursorLinkPath,
      idempotencyKey: key,
      payload: {},
    });
    return this.model.resolveSession(resolved.session.id);
  }

  private currentMatches(
    resolved: ResolvedSession,
    scope: "subtree" | "session" | "workspace" | "global",
    path: string | undefined,
    needle: string,
  ): SearchMatch[] {
    const nodes = scope === "subtree"
      ? this.model.allNodesBelow(resolved, this.model.resolvePath(resolved, path ?? "."))
      : scope === "session"
        ? this.model.allNodes(resolved)
        : this.records.listSessions(scope === "workspace" ? resolved.session.workspacePath : null)
          .flatMap((session) => this.model.allNodesAtView(
            this.records.getSessionRevision(session.id, session.headRevision),
          ));
    return nodes
      .filter((node) => this.searchable(node).includes(needle))
      .map((node) => this.searchMatch(node));
  }

  private historyMatches(sessionId: string, needle: string): SearchMatch[] {
    return this.records.listSessionRevisions(sessionId).flatMap((revision) => {
      return this.model.allNodesAtView(revision)
        .filter((node) => this.searchable(node).includes(needle))
        .map((node) => ({ ...this.searchMatch(node), revision: revision.revision }));
    });
  }

  private cursorState(resolved: ResolvedSession): CursorState {
    const current = this.model.current(resolved);
    const current_dir: CurrentDirectory = {
      path: this.model.path(current),
      canGoBack: current.linkPath.length > 0,
    };
    return { current_dir };
  }

  private pwdState(resolved: ResolvedSession): PwdState {
    return { ...this.cursorState(resolved), current_work: this.model.work(this.model.current(resolved)) };
  }

  private entries(view: View, node: ResolvedNode): EntrySummary[] {
    return this.model.entries(view, node).map(({ name, child }) => ({
      name,
      kind: child.record.attributes.kind,
      title: child.record.attributes.title,
      status: child.record.attributes.status,
      hasChildren: this.model.entries(view, child).length > 0,
    }));
  }

  private revisionSummary(
    revision: SessionRevision,
    changes: RevisionSummary["changes"],
  ): RevisionSummary {
    return { revision: revision.revision, createdAt: revision.createdAt, changes };
  }

  private proposal(proposal: Proposal): ProposalSummary {
    return {
      proposalId: proposal.id,
      kind: proposal.kind,
      status: proposal.status,
      createdAt: proposal.createdAt,
      sourceSessionId: proposal.sourceSessionId,
      patch: proposal.patch,
    };
  }

  private searchMatch(node: ResolvedNode): SearchMatch {
    return {
      path: this.model.path(node),
      name: node.names.at(-1) ?? "/",
      work: this.model.work(node),
    };
  }

  private searchable(node: ResolvedNode): string {
    const work = this.model.work(node);
    return [this.model.path(node), work.kind, work.title, work.objective, work.rationale, work.currentState]
      .join("\n")
      .toLocaleLowerCase();
  }

  private sessionIdFrom(raw: unknown): string | null {
    const value = z.object({ sessionId: z.string() }).passthrough().safeParse(raw);
    return value.success ? value.data.sessionId : null;
  }

  private diagnostic(
    sessionId: string | null,
    operation: string,
    idempotencyKey: string | null,
    outcome: "result" | "replay" | "error",
    started: number,
    before: DiagnosticState,
    result: unknown | null,
    error: unknown | null = null,
  ): void {
    const after = this.diagnosticState(sessionId);
    const base = {
      sessionId,
      operation,
      idempotencyKey,
      outcome,
      durationMs: Date.now() - started,
      beforeRootNodeId: before.rootNodeId,
      afterRootNodeId: after.rootNodeId,
      beforeRecordId: before.currentRecordId,
      afterRecordId: after.currentRecordId,
      beforeRevision: before.revision,
      afterRevision: after.revision,
      cursorDepthBefore: before.cursorDepth,
      cursorDepthAfter: after.cursorDepth,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    };
    writeDiagnostic(process.env.CONTEXT_TREE_DEBUG_CONTEXT === "1" ? { ...base, result } : base);
  }

  private diagnosticState(sessionId: string | null): DiagnosticState {
    if (sessionId === null) {
      return { rootNodeId: null, revision: null, cursorDepth: null, currentRecordId: null };
    }
    const session = this.records.findSession(sessionId);
    if (!session) {
      return { rootNodeId: null, revision: null, cursorDepth: null, currentRecordId: null };
    }
    try {
      const resolved = this.model.resolveSession(sessionId);
      return {
        rootNodeId: session.rootNodeId,
        revision: session.headRevision,
        cursorDepth: resolved.session.cursorLinkPath.length,
        currentRecordId: this.model.current(resolved).record.id,
      };
    } catch {
      return {
        rootNodeId: session.rootNodeId,
        revision: session.headRevision,
        cursorDepth: null,
        currentRecordId: null,
      };
    }
  }
}

type DiagnosticState = {
  rootNodeId: Id | null;
  revision: number | null;
  cursorDepth: number | null;
  currentRecordId: Id | null;
};

/** Transport-facing adapter boundary; it exposes no model or persistence API. */
export class FilesystemOperations {
  constructor(private readonly controller = new ContinuationController()) {}

  hello(raw: unknown): unknown {
    return this.controller.dispatch("hello", raw);
  }

  execute(raw: unknown, idempotencyKey?: string): unknown {
    return this.controller.execute(raw, idempotencyKey);
  }

  failure(id: string, error: unknown): RpcResponse {
    return this.controller.failure(id, error);
  }
}
