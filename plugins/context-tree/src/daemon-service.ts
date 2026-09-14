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
  type CdResult,
  type CloseResult,
  type CurrentDirectory,
  type CursorState,
  type EditResult,
  type EntrySummary,
  type Id,
  type MkdirResult,
  type MoveResult,
  type ProposalSummary,
  type PwdState,
  type RevisionSummary,
  type RpcResponse,
  type SearchMatch,
  type WorkPatch,
  WorkFieldsSchema,
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

  dispose(): void {
    this.records.close();
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
    const existing = this.records.findSession(input.sessionId);
    if (existing && input.cwd) this.model.validateWorkspace(existing, input.cwd);
    return this.command(input.sessionId, key, OperationSchemas.pwd.output, () => {
      if (existing) {
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

  private cd(raw: unknown, key: string | null): CdResult {
    const input = OperationSchemas.cd.input.parse(raw);
    return this.command(input.sessionId, key, OperationSchemas.cd.output, () => {
      const resolved = this.model.resolveSession(input.sessionId);
      const mutation = this.model.cd(resolved, input.path);
      const next = this.persistCursorOnly(resolved, "cd", key, mutation.cursorLinkPath);
      return { ...this.cursorState(next), movedTo: this.model.path(this.model.current(next)) };
    });
  }

  private mkdir(raw: unknown, key: string | null): MkdirResult {
    const input = OperationSchemas.mkdir.input.parse(raw);
    return this.command(input.sessionId, key, OperationSchemas.mkdir.output, () => {
      const resolved = this.model.resolveSession(input.sessionId);
      const revision = resolved.session.headRevision + 1;
      const mutation = this.model.mkdir(resolved, revision, input.name, input.work ?? {});
      const next = this.persistMutation(resolved, "mkdir", key, mutation.cursorLinkPath);
      const created = this.model.resolvePath(next, input.name);
      return { ...this.cursorState(next), created: this.entry(next.view, created) };
    });
  }

  private edit(raw: unknown, key: string | null): EditResult {
    const input = OperationSchemas.edit.input.parse(raw);
    this.assertNonTerminalPatch(input.patch);
    return this.command(input.sessionId, key, OperationSchemas.edit.output, () => {
      const resolved = this.model.resolveSession(input.sessionId);
      const current = this.model.current(resolved);
      const revision = resolved.session.headRevision + 1;
      const mutation = this.model.edit(resolved, revision, input.patch);
      const next = this.persistMutation(resolved, "edit", key, mutation.cursorLinkPath);
      return {
        ...this.cursorState(next),
        updated: { path: this.model.path(current), fields: Object.keys(input.patch).sort() },
      };
    });
  }

  private move(raw: unknown, key: string | null): MoveResult {
    const input = OperationSchemas.mv.input.parse(raw);
    return this.command(input.sessionId, key, OperationSchemas.mv.output, () => {
      const resolved = this.model.resolveSession(input.sessionId);
      const source = this.model.resolvePath(resolved, input.source);
      const from = this.model.path(source);
      const revision = resolved.session.headRevision + 1;
      const mutation = this.model.move(resolved, revision, input.source, input.destination);
      const next = this.persistMutation(resolved, "mv", key, mutation.cursorLinkPath);
      const moved = this.model.findNodeAtView(next.view, source.nodeId);
      if (moved === null) throw new RepositoryError("invariant", "moved node is not reachable");
      return { ...this.cursorState(next), moved: { from, to: this.model.path(moved) } };
    });
  }

  private close(raw: unknown, key: string | null): CloseResult {
    const input = OperationSchemas.close.input.parse(raw);
    return this.command(input.sessionId, key, OperationSchemas.close.output, () => {
      const resolved = this.model.resolveSession(input.sessionId);
      const current = this.model.current(resolved);
      const revision = resolved.session.headRevision + 1;
      const mutation = this.model.close(resolved, revision, input.summary, input.status);
      const next = this.persistMutation(resolved, "close", key, mutation.cursorLinkPath);
      return {
        ...this.cursorState(next),
        closed: { path: this.model.path(current), status: input.status, summary: input.summary },
      };
    });
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
        closedChildOutcomes: this.model.entries(resolved.view, node)
          .filter(({ child }) => ["done", "abandoned", "superseded"].includes(child.record.attributes.status))
          .map(({ name, child }) => ({
            path: this.model.path(child),
            title: child.record.attributes.title || name,
            status: child.record.attributes.status as "done" | "abandoned" | "superseded",
            summary: child.record.attributes.currentState,
          })),
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
      const candidate = input.decision === "accept" ? proposal.patch : input.replacement ?? null;
      if (candidate !== null) this.assertNonTerminalPatch(candidate);
      const revision = resolved.session.headRevision + 1;
      const decision = this.model.decideProposal(resolved, revision, proposal, input.decision, input.replacement ?? null);
      this.records.updateProposalStatus(proposal.id, decision.status);
      const next = decision.kind === "state"
        ? this.persistMutation(resolved, "decide-proposal", key, decision.cursorLinkPath)
        : this.persistCursorOnly(resolved, "decide-proposal", key, decision.cursorLinkPath);
      const finalized = { ...proposal, status: decision.status };
      return {
        ...this.cursorState(next),
        proposal: this.proposal(finalized),
        status: decision.status,
        before: this.records.getNodeRecord(proposal.baseRecordId).attributes,
        after: decision.kind === "state"
          ? this.records.resolveNodeRecord(proposal.targetNodeId, next.view).attributes
          : null,
      };
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
    return nodes.flatMap((node) => this.searchMatches(node, needle));
  }

  private historyMatches(sessionId: string, needle: string): SearchMatch[] {
    return this.records.listSessionRevisions(sessionId).flatMap((revision) => {
      return this.model.allNodesAtView(revision)
        .flatMap((node) => this.searchMatches(node, needle)
          .map((match) => ({ ...match, revision: revision.revision })));
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

  private entry(view: View, node: ResolvedNode): EntrySummary & { path: string } {
    return {
      name: node.names.at(-1) ?? "/",
      path: this.model.path(node),
      kind: node.record.attributes.kind,
      title: node.record.attributes.title,
      status: node.record.attributes.status,
      hasChildren: this.model.entries(view, node).length > 0,
    };
  }

  private revisionSummary(
    revision: SessionRevision,
    changes: RevisionSummary["changes"],
  ): RevisionSummary {
    return { revision: revision.revision, createdAt: revision.createdAt, changes };
  }

  private proposal(proposal: Proposal): ProposalSummary {
    const source = this.records.getSessionRevision(proposal.sessionId, proposal.sourceRevision);
    const target = this.model.findNodeAtView(source, proposal.targetNodeId);
    if (target === null) throw new RepositoryError("invariant", "proposal target is not reachable");
    const baseWork = this.records.getNodeRecord(proposal.baseRecordId).attributes;
    return {
      proposalId: proposal.id,
      kind: proposal.kind,
      status: proposal.status,
      createdAt: proposal.createdAt,
      sourceSessionId: proposal.sourceSessionId,
      targetPath: this.model.path(target),
      baseWork,
      patch: proposal.patch,
      afterPreview: proposal.patch === null ? null : WorkFieldsSchema.parse({ ...baseWork, ...proposal.patch }),
    };
  }

  private searchMatches(node: ResolvedNode, needle: string): SearchMatch[] {
    const work = this.model.work(node);
    const fields: Array<[string, string]> = [
      ["path", this.model.path(node)],
      ["kind", work.kind],
      ["title", work.title],
      ["objective", work.objective],
      ["rationale", work.rationale],
      ["currentState", work.currentState],
      ["openQuestions", work.openQuestions.join("\n")],
      ["returnCondition", work.returnCondition],
      ["refs", JSON.stringify(work.refs)],
      ["metadata", JSON.stringify(work.metadata)],
    ];
    return fields.flatMap(([field, value]) => {
      const index = value.toLocaleLowerCase().indexOf(needle);
      if (index < 0) return [];
      return [{
        path: this.model.path(node),
        name: node.names.at(-1) ?? "/",
        field,
        snippet: this.snippet(value, index, needle.length),
        status: work.status,
      }];
    });
  }

  private snippet(value: string, index: number, length: number): string {
    const radius = 72;
    const start = Math.max(0, index - radius);
    const end = Math.min(value.length, index + length + radius);
    return (start > 0 ? "…" : "") + value.slice(start, end) + (end < value.length ? "…" : "");
  }

  private assertNonTerminalPatch(patch: WorkPatch): void {
    if (patch.status && ["done", "abandoned", "superseded"].includes(patch.status)) {
      throw new RepositoryError("invariant", "terminal status must be set with close");
    }
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

  dispose(): void {
    this.controller.dispose();
  }

  failure(id: string, error: unknown): RpcResponse {
    return this.controller.failure(id, error);
  }
}
