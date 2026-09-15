import { z } from "zod";
import { parseCommand } from "./command-registry.js";
import { ContinuationModel, type ResolvedNode, type ResolvedSession } from "../domain/continuation-model.js";
import { RepositoryError, type Id, type LinkRecord, type NodeRecord, type Proposal, type RecordRepository, type SessionEventDocument, type SessionRevision, type View } from "../persistence/record-repository.js";
import { writeDiagnostic } from "../../runtime/diagnostics.js";
import {
  CommandInputSchema,
  type BriefingResult,
  type CdResult,
  type CloseResult,
  type CurrentDirectory,
  type CursorState,
  type EditResult,
  type EntrySummary,
  type IdentityResult,
  type MailboxResult,
  type MailboxDecisionResult,
  type AccessResult,
  type MkdirResult,
  type MoveResult,
  type ProposalSummary,
  type PwdState,
  type QueryLinkResult,
  type RevisionSummary,
  type SearchMatch,
  type WorkPatch,
  WorkFieldsSchema,
} from "../../../protocol/schema.js";
import { OperationSchemas } from "./operation-schemas.js";

/** Transactional controller for the public filesystem use cases. */
export class ContinuationController {
  private readonly model: ContinuationModel;

  constructor(private readonly records: RecordRepository) {
    this.model = new ContinuationModel(records);
  }

  execute(raw: unknown, idempotencyKey?: string): unknown {
    const input = CommandInputSchema.parse(raw);
    if (input.branch !== undefined && input.branch !== "main") {
      throw new RepositoryError("not_found", "v9 exposes only the main branch");
    }
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

  private dispatchValidated(name: keyof typeof OperationSchemas, raw: unknown, key: string | null): unknown {
    switch (name) {
      case "pwd": return this.pwd(raw, key);
      case "ls": return this.ls(raw);
      case "cd": return this.cd(raw, key);
      case "mkdir": return this.mkdir(raw, key);
      case "edit": return this.edit(raw, key);
      case "mv": return this.move(raw, key);
      case "close": return this.close(raw, key);
      case "search": return this.search(raw);
      case "rev-list": return this.revisionList(raw);
      case "query-link": return this.queryLink(raw);
      case "rev-show": return this.revisionShow(raw);
      case "fork": return this.fork(raw, key);
      case "set-identity": return this.setIdentity(raw, key);
      case "publish": return this.publish(raw, key);
      case "withdraw": return this.withdraw(raw, key);
      case "chmod": return this.chmod(raw, key);
      case "briefing": return this.briefing(raw);
      case "proposals": return this.proposals(raw);
      case "decide-proposal": return this.decideProposal(raw, key);
      case "decide-mailbox": return this.decideMailbox(raw, key);
      case "submit-proposal": return this.submitProposal(raw, key);
    }
  }

  private pwd(raw: unknown, key: string | null): PwdState {
    const input = OperationSchemas.pwd.input.parse(raw);
    const existing = this.records.findSession(input.sessionId);
    if (existing && existing.branchId !== 0 && input.cwd) this.model.validateWorkspace(existing, input.cwd);
    return this.command(input.sessionId, key, OperationSchemas.pwd.output, () => {
      if (existing && existing.branchId !== 0) {
        return this.pwdState(this.model.resolveSession(input.sessionId));
      }
      const created = this.model.createSession(input.sessionId, input.cwd ?? process.cwd());
      if (created.nodeRecords.length === 0) {
        return this.pwdState(this.model.resolveSession(input.sessionId));
      }
      const attached = this.records.getSession(input.sessionId);
      const revision = this.records.reserveNextRevision(attached.branchId);
      this.records.insertSpan(attached.branchId, revision, null);
      this.records.publishReferences(attached.branchId, revision, created.nodeRecords, []);
      this.records.updateSessionHead(input.sessionId, revision, created.cursorLinkPath);
      this.appendEvent(input.sessionId, revision, "session-created", created.rootNodeId, created.cursorLinkPath, key, {});
      return this.pwdState(this.model.resolveSession(input.sessionId));
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
        ...(input.briefing ? { childBriefings: this.childBriefings(live.view, listed) } : {}),
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
      ...(input.briefing ? { childBriefings: this.childBriefings(view.selected, view.node) } : {}),
    };
  }

  private cd(raw: unknown, key: string | null): CdResult {
    const input = OperationSchemas.cd.input.parse(raw);
    return this.command(input.sessionId, key, OperationSchemas.cd.output, () => {
      const resolved = this.model.resolveSession(input.sessionId);
      const mutation = this.model.cd(resolved, input.path);
      const next = this.persistCursorOnly(resolved, "cd", key, mutation.cursorLinkPath);
      return {
        ...this.cursorState(next),
        movedTo: this.model.path(this.model.current(next)),
        briefing: this.briefingEntries(next),
      };
    });
  }

  private mkdir(raw: unknown, key: string | null): MkdirResult {
    const input = OperationSchemas.mkdir.input.parse(raw);
    return this.command(input.sessionId, key, OperationSchemas.mkdir.output, () => {
      const resolved = this.model.resolveSession(input.sessionId);
      const mutation = this.model.mkdir(resolved, input.name, input.work ?? {}, input.local ?? false);
      const next = this.persistMutation(resolved, "mkdir", key, mutation);
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
      const mutation = this.model.edit(resolved, input.patch, input.local ?? false);
      const next = this.persistMutation(resolved, "edit", key, mutation);
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
      const mutation = this.model.move(resolved, input.source, input.destination, input.local ?? false);
      const next = this.persistMutation(resolved, "mv", key, mutation);
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
      const mutation = this.model.close(resolved, input.summary, input.status, input.local ?? false);
      const next = this.persistMutation(resolved, "close", key, mutation);
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
    const revisions = this.model.history(input.sessionId, input.reference, input.path ?? ".", input.verbose)
      .map(({ revision, changes, createdView }) => this.revisionSummary(revision, changes, createdView));
    return { ...this.cursorState(resolved), head_revision: resolved.session.headRevision, revisions };
  }

  private queryLink(raw: unknown): QueryLinkResult {
    const input = OperationSchemas["query-link"].input.parse(raw);
    const live = this.model.resolveSession(input.sessionId);
    const history = this.model.linkHistory(
      input.sessionId,
      input.direction,
      input.revision,
      input.reference,
      input.path ?? ".",
    );
    return {
      ...this.cursorState(live),
      view: { sessionId: history.view.sessionId, revision: history.view.revision },
      node_path: this.model.path(history.node),
      direction: input.direction,
      links: history.links.map((link) => ({
        name: link.name,
        revisions: link.records.map((record) => ({
          created_view: { sessionId: record.sessionId, revision: record.revision },
          name: record.name,
          createdAt: record.createdAt,
        })),
      })),
    };
  }

  private revisionShow(raw: unknown) {
    const input = OperationSchemas["rev-show"].input.parse(raw);
    const resolved = this.model.resolveSession(input.sessionId);

    if (input.revision === undefined) {
      if (input.reference !== undefined) {
        throw new RepositoryError("invariant", "rev-show --reference requires a selected revision");
      }

      const node = this.model.resolvePath(resolved, input.path ?? ".");
      return {
        ...this.cursorState(resolved),
        details: {
          revision: this.revisionSummary(resolved.view, []),
          view_path: this.model.path(node),
          work: this.model.work(node),
          entries: this.entries(resolved.view, node),
        },
      };
    }

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
      throw new RepositoryError("invariant", "explicit forks are deferred in the shared-mainline v9 store");
    });
  }

  private setIdentity(raw: unknown, key: string | null): IdentityResult {
    const input = OperationSchemas["set-identity"].input.parse(raw);
    return this.command(input.sessionId, key, OperationSchemas["set-identity"].output, () => {
      const session = this.records.setIdentity(
        input.sessionId,
        input.userId,
        input.groups ?? [],
        input.metadata ?? {},
      );
      return { userId: session.userId, groups: session.groups };
    });
  }

  private publish(raw: unknown, key: string | null): MailboxResult {
    const input = OperationSchemas.publish.input.parse(raw);
    return this.command(input.sessionId, key, OperationSchemas.publish.output, () => {
      const resolved = this.model.resolveSession(input.sessionId);
      const target = this.model.resolvePath(resolved, input.path ?? ".");
      const overlay = this.records.latestOverlay(
        resolved.session.id,
        "inode",
        target.nodeId,
        resolved.session.overlayHeadRevision,
      );
      if (overlay === null) throw new RepositoryError("not_found", "no local overlay exists for this node");
      this.records.publishMailbox({
        authorityInodeId: target.nodeId,
        subjectKind: "inode",
        subjectId: target.nodeId,
        authorSessionId: resolved.session.id,
        publishedOverlayRevision: overlay.overlayRevision,
        baseBranchId: overlay.baseBranchId,
        baseBranchRevision: overlay.baseBranchRevision,
        baseRecordId: overlay.baseRecordId,
        candidateRecordId: overlay.candidateRecordId,
        publishedAt: new Date().toISOString(),
      });
      this.appendEvent(resolved.session.id, null, "publish", target.nodeId, resolved.session.cursorLinkPath, key, {});
      return { ...this.cursorState(resolved), path: this.model.path(target), subject: "inode", published: true };
    });
  }

  private withdraw(raw: unknown, key: string | null): MailboxResult {
    const input = OperationSchemas.withdraw.input.parse(raw);
    return this.command(input.sessionId, key, OperationSchemas.withdraw.output, () => {
      const resolved = this.model.resolveSession(input.sessionId);
      const target = this.model.resolvePath(resolved, input.path ?? ".");
      this.records.withdrawMailbox(target.nodeId, "inode", target.nodeId, resolved.session.id);
      this.appendEvent(resolved.session.id, null, "withdraw", target.nodeId, resolved.session.cursorLinkPath, key, {});
      return { ...this.cursorState(resolved), path: this.model.path(target), subject: "inode", published: false };
    });
  }

  private chmod(raw: unknown, key: string | null): AccessResult {
    const input = OperationSchemas.chmod.input.parse(raw);
    return this.command(input.sessionId, key, OperationSchemas.chmod.output, () => {
      const resolved = this.model.resolveSession(input.sessionId);
      const target = this.model.resolvePath(resolved, input.path ?? ".");
      const inode = this.records.getInode(target.nodeId);
      if (inode.ownerUserId !== resolved.session.userId) {
        throw new RepositoryError("conflict", "only the inode owner may change access modes");
      }
      const groupId = input.groupId === undefined ? inode.groupId : input.groupId;
      this.records.updateInodeAccess(target.nodeId, {
        content: input.contentAccess,
        topology: input.topologyAccess,
      }, groupId);
      this.appendEvent(resolved.session.id, null, "chmod", target.nodeId, resolved.session.cursorLinkPath, key, {});
      return {
        ...this.cursorState(resolved),
        path: this.model.path(target),
        contentAccess: input.contentAccess,
        topologyAccess: input.topologyAccess,
        groupId,
      };
    });
  }

  private briefing(raw: unknown): BriefingResult {
    const input = OperationSchemas.briefing.input.parse(raw);
    const resolved = this.model.resolveSession(input.sessionId);
    return {
      ...this.cursorState(resolved),
      ancestry: this.briefingEntries(resolved),
      pendingProposalCount: this.records.listPendingProposals(input.sessionId).length,
      unresolvedCount: this.model.allNodes(resolved)
        .filter((node) => !["done", "abandoned", "superseded"].includes(node.record.attributes.status))
        .length,
    };
  }

  private proposals(raw: unknown) {
    const input = OperationSchemas.proposals.input.parse(raw);
    const resolved = this.model.resolveSession(input.sessionId);
    if (input.scope === "inbox") {
      return {
        ...this.cursorState(resolved),
        proposals: [],
        mailbox: this.records.listMailbox(resolved.session.userId).map((entry) => {
          const node = this.model.findNodeAtView(resolved.view, entry.authorityInodeId);
          const current = this.records.resolveNodeRecord(entry.authorityInodeId, {
            ...resolved.view,
            overlaySessionId: null,
            overlayHeadRevision: 0,
          });
          return {
            path: node === null ? "(not reachable)" : this.model.path(node),
            subject: entry.subjectKind,
            authorSessionId: entry.authorSessionId,
            publishedAt: entry.publishedAt,
            baseWork: entry.subjectKind === "inode" ? this.records.getNodeRecord(entry.baseRecordId).attributes : null,
            candidateWork: entry.subjectKind === "inode" ? this.records.getNodeRecord(entry.candidateRecordId).attributes : null,
            stale: current.id !== entry.baseRecordId,
          };
        }),
      };
    }
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
      const decision = this.model.decideProposal(resolved, proposal, input.decision, input.replacement ?? null);
      this.records.updateProposalStatus(proposal.id, decision.status);
      const next = decision.kind === "state"
        ? this.persistMutation(resolved, "decide-proposal", key, {
          cursorLinkPath: decision.cursorLinkPath,
          nodeRecords: decision.nodeRecords,
          linkRecords: [],
        })
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

  private decideMailbox(raw: unknown, key: string | null): MailboxDecisionResult {
    const input = OperationSchemas["decide-mailbox"].input.parse(raw);
    return this.command(input.sessionId, key, OperationSchemas["decide-mailbox"].output, () => {
      const resolved = this.model.resolveSession(input.sessionId);
      const target = this.model.resolvePath(resolved, input.path);
      const inode = this.records.getInode(target.nodeId);
      if (inode.ownerUserId !== resolved.session.userId) {
        throw new RepositoryError("conflict", "only the inode owner may decide its mailbox candidates");
      }
      const entry = this.records.getMailbox(target.nodeId, "inode", target.nodeId, input.authorSessionId);
      if (entry === null) throw new RepositoryError("not_found", "mailbox candidate not found");
      const authoritative = this.records.resolveNodeRecord(target.nodeId, {
        ...resolved.view,
        overlaySessionId: null,
        overlayHeadRevision: 0,
      });
      const before = authoritative.attributes;

      if (input.decision === "reject") {
        this.records.withdrawMailbox(target.nodeId, "inode", target.nodeId, input.authorSessionId);
        this.appendEvent(resolved.session.id, null, "mailbox-reject", target.nodeId, resolved.session.cursorLinkPath, key, {});
        return {
          ...this.cursorState(resolved),
          path: this.model.path(target),
          authorSessionId: input.authorSessionId,
          status: "rejected",
          before,
          after: null,
        };
      }

      if (authoritative.id !== entry.baseRecordId) {
        throw new RepositoryError("conflict", "mailbox candidate is stale against the current mainline record");
      }
      const replacement = input.decision === "replace"
        ? input.replacement
        : null;
      if (input.decision === "replace" && replacement === undefined) {
        throw new RepositoryError("invariant", "replace requires a work patch");
      }
      this.assertNonTerminalPatch(replacement ?? {});
      const candidate = input.decision === "accept"
        ? this.records.getNodeRecord(entry.candidateRecordId)
        : this.records.insertNodeRecord(target.nodeId, WorkFieldsSchema.parse({ ...before, ...replacement }));
      if (candidate.nodeId !== target.nodeId) throw new RepositoryError("invariant", "mailbox candidate targets the wrong inode");
      const next = this.persistMutation(resolved, "mailbox-accept", key, {
        cursorLinkPath: resolved.session.cursorLinkPath,
        mode: "main",
        nodeRecords: [candidate],
        linkRecords: [],
        overlays: [],
      });
      this.records.withdrawMailbox(target.nodeId, "inode", target.nodeId, input.authorSessionId);
      return {
        ...this.cursorState(next),
        path: this.model.path(target),
        authorSessionId: input.authorSessionId,
        status: "applied",
        before,
        after: this.records.resolveNodeRecord(target.nodeId, next.view).attributes,
      };
    });
  }

  private submitProposal(raw: unknown, key: string | null): ProposalSummary {
    const input = OperationSchemas["submit-proposal"].input.parse(raw);
    return this.command(input.sessionId, key, OperationSchemas["submit-proposal"].output, () => {
      const resolved = this.model.resolveSession(input.sessionId);
      const proposal = this.model.createProposal(resolved, input.kind, input.patch ?? null, input.sourceSessionId ?? null);
      this.appendEvent(input.sessionId, null, "submit-proposal", null, resolved.session.cursorLinkPath, key, {
        proposalId: proposal.id,
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

  private appendEvent(
    sessionId: string,
    revision: number | null,
    action: string,
    rootNodeId: Id | null,
    cursorLinkPath: Id[],
    idempotencyKey: string | null,
    details: SessionEventDocument["details"],
  ): void {
    this.records.appendEvent(sessionId, revision, {
      action,
      rootNodeId,
      cursorLinkPath,
      idempotencyKey,
      details,
      createdAt: new Date().toISOString(),
    });
  }

  private persistMutation(
    resolved: ResolvedSession,
    operation: string,
    key: string | null,
    mutation: {
      cursorLinkPath: Id[];
      mode?: "main" | "overlay";
      nodeRecords: readonly NodeRecord[];
      linkRecords: readonly { record: LinkRecord; previousParentNodeId: Id | null }[];
      overlays?: ReadonlyArray<{
        subjectKind: "inode" | "link";
        subjectId: Id;
        authorityInodeId: Id;
        baseRecordId: Id;
        candidateRecordId: Id;
        parentNodeId: Id | null;
      }>;
    },
  ): ResolvedSession {
    if (mutation.mode === "overlay") {
      const overlayRevision = resolved.session.overlayHeadRevision + 1;
      for (const overlay of mutation.overlays ?? []) {
        this.records.appendOverlay({
          sessionId: resolved.session.id,
          subjectKind: overlay.subjectKind,
          subjectId: overlay.subjectId,
          overlayRevision,
          baseBranchId: resolved.view.branchId,
          baseBranchRevision: resolved.view.revision,
          baseRecordId: overlay.baseRecordId,
          candidateRecordId: overlay.candidateRecordId,
          parentNodeId: overlay.parentNodeId,
          createdAt: new Date().toISOString(),
        });
      }
      this.records.updateSessionCursor(resolved.session.id, mutation.cursorLinkPath);
      this.appendEvent(resolved.session.id, null, operation + "-overlay", resolved.view.rootNodeId, mutation.cursorLinkPath, key, {});
      return this.model.resolveSession(resolved.session.id);
    }
    const revision = this.records.reserveNextRevision(resolved.session.branchId);
    this.records.publishReferences(resolved.session.branchId, revision, mutation.nodeRecords, mutation.linkRecords);
    this.records.updateSessionHead(resolved.session.id, revision, mutation.cursorLinkPath);
    this.appendEvent(resolved.session.id, revision, operation, resolved.view.rootNodeId, mutation.cursorLinkPath, key, {});
    return this.model.resolveSession(resolved.session.id);
  }

  private persistCursorOnly(
    resolved: ResolvedSession,
    operation: string,
    key: string | null,
    cursorLinkPath: Id[],
  ): ResolvedSession {
    this.records.updateSessionCursor(resolved.session.id, cursorLinkPath);
    this.appendEvent(resolved.session.id, null, operation, null, cursorLinkPath, key, {});
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
    return {
      current_dir,
      current_fork: { name: "main", revision: resolved.view.revision },
    };
  }

  private briefingEntries(resolved: ResolvedSession): BriefingResult["ancestry"] {
    return resolved.nodes.map((node) => ({
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
    }));
  }

  private childBriefings(view: View, node: ResolvedNode): BriefingResult["ancestry"] {
    return this.model.entries(view, node).map(({ child }) => ({
      path: this.model.path(child),
      work: this.model.work(child),
      closedChildOutcomes: this.model.entries(view, child)
        .filter(({ child: grandchild }) => ["done", "abandoned", "superseded"].includes(grandchild.record.attributes.status))
        .map(({ name, child: grandchild }) => ({
          path: this.model.path(grandchild),
          title: grandchild.record.attributes.title || name,
          status: grandchild.record.attributes.status as "done" | "abandoned" | "superseded",
          summary: grandchild.record.attributes.currentState,
        })),
    }));
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
    created_view?: RevisionSummary["created_view"],
  ): RevisionSummary {
    const summary = { revision: revision.revision, createdAt: revision.createdAt, changes };
    return created_view === undefined ? summary : { ...summary, created_view };
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
