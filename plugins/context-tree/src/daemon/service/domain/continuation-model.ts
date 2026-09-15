import { resolve as resolveFilesystemPath } from "node:path";
import {
  RepositoryError,
  type EffectiveLink,
  type Id,
  type LinkRecord,
  type NodeRecord,
  type Proposal,
  type RecordRepository,
  type Session,
  type SessionRevision,
  type View,
} from "../persistence/record-repository.js";
import {
  WorkFieldsSchema,
  type ProposalDecision,
  type WorkFields,
  type WorkPatch,
} from "../../../protocol/schema.js";

const terminal = new Set(["done", "abandoned", "superseded"]);

export type ResolvedNode = {
  nodeId: Id;
  record: NodeRecord;
  linkPath: Id[];
  names: string[];
  linkId: Id | null;
};

export type ResolvedSession = {
  session: Session;
  view: SessionRevision;
  nodes: ResolvedNode[];
};

export type StateMutation = {
  changed: boolean;
  cursorLinkPath: Id[];
  nodeRecords: NodeRecord[];
  linkRecords: Array<{ record: LinkRecord; previousParentNodeId: Id | null }>;
};

export type InitializedSession = {
  rootNodeId: Id;
  cursorLinkPath: Id[];
  nodeRecords: NodeRecord[];
};

export type LinkHistoryQuery = {
  view: SessionRevision;
  node: ResolvedNode;
  links: Array<{ name: string; records: LinkRecord[] }>;
};

export type ProposalMutation =
  | { kind: "unchanged"; cursorLinkPath: Id[]; status: "rejected" | "discarded" }
  | { kind: "state"; cursorLinkPath: Id[]; status: "applied"; nodeRecords: NodeRecord[] };

type PathSegment = { value: string; escaped: boolean };
type LinkLocation = { parentNodeId: Id; name: string };

/**
 * v8 creates physical records first. The controller alone publishes their
 * references into the session revision selected by this mutation.
 */
export class ContinuationModel {
  constructor(private readonly records: RecordRepository) {}

  createSession(sessionId: string, cwd: string): InitializedSession {
    const createdAt = this.timestamp();
    const rootNodeId = this.records.createNode();
    const rootRecord = this.records.insertNodeRecord(rootNodeId, this.emptyWork());
    this.records.insertSession({
      id: sessionId,
      workspacePath: resolveFilesystemPath(cwd),
      rootNodeId,
      headRevision: -1,
      headRevisionCreatedAt: createdAt,
      cursorLinkPath: [],
      createdAt,
      updatedAt: createdAt,
    });
    return { rootNodeId, cursorLinkPath: [], nodeRecords: [rootRecord] };
  }

  validateWorkspace(session: Session, cwd: string): void {
    if (session.workspacePath !== resolveFilesystemPath(cwd)) {
      throw new RepositoryError("conflict", "session is bound to a different workspace");
    }
  }

  resolveSession(sessionId: string): ResolvedSession {
    const { session, view } = this.records.getHeadSessionView(sessionId);
    const root = this.root(view);
    const nodes = [root];
    let current = root;
    for (const linkId of session.cursorLinkPath) {
      current = this.resolveChild(view, current, linkId);
      nodes.push(current);
    }
    return { session, view, nodes };
  }

  resolveSessionRevision(sessionId: string, revision: number): { session: Session; view: SessionRevision } {
    return { session: this.records.getSession(sessionId), view: this.records.getSessionRevision(sessionId, revision) };
  }

  resolvePath(resolved: ResolvedSession, rawPath: string): ResolvedNode {
    return this.resolvePathAt(resolved.view, this.current(resolved), rawPath);
  }

  resolveView(
    sessionId: string,
    selectedRevision: number,
    referenceRevision: number | undefined,
    rawPath: string,
  ): { selected: SessionRevision; node: ResolvedNode } {
    const session = this.records.getSession(sessionId);
    const reference = this.referenceNode(session, referenceRevision, rawPath);
    const selected = this.records.getSessionRevision(sessionId, selectedRevision);
    const node = this.findNode(selected, reference.nodeId);
    if (node === null) throw new RepositoryError("not_found", "node did not exist in selected revision r" + selectedRevision);
    return { selected, node };
  }

  mkdir(resolved: ResolvedSession, name: string, patch: WorkPatch): StateMutation {
    const parent = this.current(resolved);
    const normalizedName = this.normalizeName(name);
    this.ensureNameAvailable(this.entries(resolved.view, parent), normalizedName);
    const childNodeId = this.records.createNode();
    const link = this.records.createLink(childNodeId);
    const childRecord = this.records.insertNodeRecord(childNodeId, this.mergeWork(this.emptyWork(), patch));
    const linkRecord = this.records.insertLinkRecord(link.id, parent.nodeId, normalizedName);
    return {
      changed: true,
      cursorLinkPath: resolved.session.cursorLinkPath,
      nodeRecords: [childRecord],
      linkRecords: [{ record: linkRecord, previousParentNodeId: null }],
    };
  }

  edit(resolved: ResolvedSession, patch: WorkPatch): StateMutation {
    const current = this.current(resolved);
    const record = this.records.insertNodeRecord(current.nodeId, this.mergeWork(current.record.attributes, patch));
    return { changed: true, cursorLinkPath: resolved.session.cursorLinkPath, nodeRecords: [record], linkRecords: [] };
  }

  cd(resolved: ResolvedSession, path: string): StateMutation {
    return { changed: false, cursorLinkPath: this.resolvePath(resolved, path).linkPath, nodeRecords: [], linkRecords: [] };
  }

  close(
    resolved: ResolvedSession,
    summary: string,
    status: "done" | "abandoned" | "superseded",
  ): StateMutation {
    const current = this.current(resolved);
    if (this.hasOpenDescendant(resolved.view, current, new Set([current.nodeId]))) {
      throw new RepositoryError("invariant", "cannot close a node with open descendants");
    }
    const record = this.records.insertNodeRecord(
      current.nodeId,
      this.mergeWork(current.record.attributes, { status, currentState: summary }),
    );
    return {
      changed: true,
      cursorLinkPath: current.linkPath.length === 0 ? current.linkPath : current.linkPath.slice(0, -1),
      nodeRecords: [record],
      linkRecords: [],
    };
  }

  move(resolved: ResolvedSession, sourcePath: string, destinationPath: string): StateMutation {
    const source = this.resolvePath(resolved, sourcePath);
    if (source.linkId === null || source.linkPath.length === 0) {
      throw new RepositoryError("invariant", "cannot move the root node");
    }
    const sourceLink = this.records.resolveLinkRecord(source.linkId, resolved.view);
    const destination = this.resolveMoveDestination(resolved, destinationPath, sourceLink.name);
    if (this.startsWith(destination.parent.linkPath, source.linkPath)) {
      throw new RepositoryError("invariant", "cannot move a node into its descendant");
    }
    this.ensureMoveName(resolved.view, destination.parent, source.linkId, destination.name);
    const record = this.records.insertLinkRecord(source.linkId, destination.parent.nodeId, destination.name);
    return {
      changed: true,
      cursorLinkPath: this.repairMovedCursor(
        resolved.session.cursorLinkPath,
        source.linkPath,
        [...destination.parent.linkPath, source.linkId],
      ),
      nodeRecords: [],
      linkRecords: [{ record, previousParentNodeId: sourceLink.parentNodeId }],
    };
  }

  fork(resolved: ResolvedSession, newSessionId: string): InitializedSession {
    const existing = this.records.findSession(newSessionId);
    if (existing !== null) {
      return { rootNodeId: existing.rootNodeId, cursorLinkPath: existing.cursorLinkPath, nodeRecords: [] };
    }
    const createdAt = this.timestamp();
    this.records.insertSession({
      id: newSessionId,
      workspacePath: resolved.session.workspacePath,
      rootNodeId: resolved.view.rootNodeId,
      headRevision: -1,
      headRevisionCreatedAt: createdAt,
      cursorLinkPath: resolved.session.cursorLinkPath,
      createdAt,
      updatedAt: createdAt,
    });
    return {
      rootNodeId: resolved.view.rootNodeId,
      cursorLinkPath: resolved.session.cursorLinkPath,
      nodeRecords: [],
    };
  }

  createProposal(
    resolved: ResolvedSession,
    kind: Proposal["kind"],
    patch: WorkPatch | null,
    sourceSessionId: string | null,
  ): Proposal {
    const current = this.current(resolved);
    return this.records.insertProposal({
      sessionId: resolved.session.id,
      sourceSessionId,
      sourceRevision: resolved.view.revision,
      targetNodeId: current.nodeId,
      baseRecordId: current.record.id,
      patch,
      kind,
      status: "pending",
      createdAt: this.timestamp(),
      decidedAt: null,
    });
  }

  decideProposal(
    resolved: ResolvedSession,
    proposal: Proposal,
    decision: ProposalDecision,
    replacement: WorkPatch | null,
  ): ProposalMutation {
    if (decision === "reject" || decision === "discard") {
      return { kind: "unchanged", cursorLinkPath: resolved.session.cursorLinkPath, status: decision === "reject" ? "rejected" : "discarded" };
    }
    const current = this.records.resolveNodeRecord(proposal.targetNodeId, resolved.view);
    if (current.id !== proposal.baseRecordId) {
      throw new RepositoryError("conflict", "proposal target changed since it was created");
    }
    const patch = decision === "accept" ? proposal.patch : replacement;
    if (patch === null) throw new RepositoryError("invariant", "proposal decision requires a patch");
    const record = this.records.insertNodeRecord(proposal.targetNodeId, this.mergeWork(current.attributes, patch));
    return { kind: "state", cursorLinkPath: resolved.session.cursorLinkPath, status: "applied", nodeRecords: [record] };
  }

  allNodes(resolved: ResolvedSession): ResolvedNode[] {
    return this.walk(resolved.view, this.root(resolved.view));
  }

  allNodesBelow(resolved: ResolvedSession, node: ResolvedNode): ResolvedNode[] {
    return this.walk(resolved.view, node);
  }

  allNodesAtView(view: View): ResolvedNode[] {
    return this.walk(view, this.root(view));
  }

  findNodeAtView(view: View, nodeId: Id): ResolvedNode | null {
    return this.findNode(view, nodeId);
  }

  rootNeedsInitialization(resolved: ResolvedSession): boolean {
    const work = this.work(resolved.nodes[0]);
    return !work.objective || !work.rationale || !work.returnCondition;
  }

  history(
    sessionId: string,
    referenceRevision: number | undefined,
    rawPath: string,
    includeCreatedView = false,
  ): Array<{
    revision: SessionRevision;
    changes: Array<"work" | "children" | "renamed" | "moved">;
    createdView?: { sessionId: string; revision: number };
  }> {
    const session = this.records.getSession(sessionId);
    const reference = this.referenceNode(session, referenceRevision, rawPath);
    let previous: { view: SessionRevision; node: ResolvedNode; location: LinkLocation | null } | null = null;
    const output: Array<{
      revision: SessionRevision;
      changes: Array<"work" | "children" | "renamed" | "moved">;
      createdView?: { sessionId: string; revision: number };
    }> = [];
    for (const view of this.records.listSessionRevisions(sessionId)) {
      const node = this.findNode(view, reference.nodeId);
      if (node === null) continue;
      const location = reference.linkId === null ? null : this.linkLocation(view, reference.linkId);
      const changes = this.semanticChanges(view, previous, { node, location });
      const entry = { revision: view, changes };
      output.push(includeCreatedView
        ? { ...entry, createdView: { sessionId: node.record.sessionId, revision: node.record.revision } }
        : entry);
      previous = { view, node, location };
    }
    return output;
  }

  linkHistory(
    sessionId: string,
    direction: "parent" | "child",
    revision: number | undefined,
    referenceRevision: number | undefined,
    rawPath: string,
  ): LinkHistoryQuery {
    const live = this.resolveSession(sessionId);
    let selected: SessionRevision;
    let node: ResolvedNode;

    if (revision === undefined) {
      selected = live.view;
      node = this.resolvePath(live, rawPath);
    } else {
      const historical = this.resolveView(sessionId, revision, referenceRevision, rawPath);
      selected = historical.selected;
      node = historical.node;
    }

    const links = direction === "parent"
      ? this.parentLinkHistory(selected, node)
      : this.childLinkHistory(selected, node);
    return { view: selected, node, links };
  }

  work(node: ResolvedNode): WorkFields {
    return node.record.attributes;
  }

  current(resolved: ResolvedSession): ResolvedNode {
    const current = resolved.nodes.at(-1);
    if (current === undefined) throw new RepositoryError("invariant", "session has no root node");
    return current;
  }

  entries(view: View, node: ResolvedNode): Array<{ name: string; child: ResolvedNode }> {
    return this.records.listEffectiveLinks(node.nodeId, view).map((link) => ({
      name: link.name,
      child: this.resolveEffectiveLink(view, node, link),
    }));
  }

  path(node: ResolvedNode): string {
    return node.names.length === 0 ? "/" : "/" + node.names.map((name) => this.escapeName(name)).join("/");
  }

  private root(view: View): ResolvedNode {
    return this.resolveNode(view, view.rootNodeId, [], [], null);
  }

  private parentLinkHistory(view: View, node: ResolvedNode): Array<{ name: string; records: LinkRecord[] }> {
    if (node.linkId === null) return [];
    const link = this.records.resolveLinkRecord(node.linkId, view);
    return [{ name: link.name, records: this.records.listVisibleLinkRecords(node.linkId, view) }];
  }

  private childLinkHistory(view: View, node: ResolvedNode): Array<{ name: string; records: LinkRecord[] }> {
    return this.entries(view, node).map(({ name, child }) => {
      if (child.linkId === null) throw new RepositoryError("invariant", "child is missing a directory link");
      return { name, records: this.records.listVisibleLinkRecords(child.linkId, view) };
    });
  }

  private resolveNode(view: View, nodeId: Id, linkPath: Id[], names: string[], linkId: Id | null): ResolvedNode {
    return { nodeId, record: this.records.resolveNodeRecord(nodeId, view), linkPath, names, linkId };
  }

  private resolveChild(view: View, parent: ResolvedNode, linkId: Id): ResolvedNode {
    const link = this.records.resolveLinkRecord(linkId, view);
    if (link.parentNodeId !== parent.nodeId) throw new RepositoryError("not_found", "link path is not reachable");
    const stable = this.records.getLink(linkId);
    return this.resolveEffectiveLink(view, parent, { ...link, childNodeId: stable.childNodeId });
  }

  private resolveEffectiveLink(view: View, parent: ResolvedNode, link: EffectiveLink): ResolvedNode {
    if (link.parentNodeId !== parent.nodeId) throw new RepositoryError("invariant", "link resolves to the wrong parent");
    return this.resolveNode(
      view,
      link.childNodeId,
      [...parent.linkPath, link.linkId],
      [...parent.names, link.name],
      link.linkId,
    );
  }

  private resolvePathAt(view: View, start: ResolvedNode, rawPath: string): ResolvedNode {
    if (rawPath === ".") return start;
    let current = rawPath.startsWith("/") ? this.root(view) : start;
    for (const segment of this.parsePath(rawPath)) {
      if (!segment.escaped && segment.value === ".") continue;
      if (!segment.escaped && segment.value === "..") {
        if (current.linkPath.length > 0) current = this.resolveLinkPath(view, current.linkPath.slice(0, -1));
        continue;
      }
      const child = this.entries(view, current).find((entry) => entry.name === segment.value);
      if (child === undefined) throw new RepositoryError("not_found", "path not found: " + rawPath);
      current = child.child;
    }
    return current;
  }

  private resolveLinkPath(view: View, linkPath: Id[]): ResolvedNode {
    let current = this.root(view);
    for (const linkId of linkPath) current = this.resolveChild(view, current, linkId);
    return current;
  }

  private referenceNode(session: Session, referenceRevision: number | undefined, rawPath: string): ResolvedNode {
    if (referenceRevision === undefined || referenceRevision === session.headRevision) {
      return this.resolvePath(this.resolveSession(session.id), rawPath || ".");
    }
    const revision = referenceRevision ?? session.headRevision;
    const view = this.records.getSessionRevision(session.id, revision);
    return this.resolvePathAt(view, this.root(view), rawPath || ".");
  }

  private findNode(view: View, nodeId: Id): ResolvedNode | null {
    const visit = (node: ResolvedNode, visited: Set<Id>): ResolvedNode | null => {
      if (node.nodeId === nodeId) return node;
      if (visited.has(node.nodeId)) return null;
      visited.add(node.nodeId);
      for (const { child } of this.entries(view, node)) {
        const found = visit(child, visited);
        if (found !== null) return found;
      }
      return null;
    };
    return visit(this.root(view), new Set());
  }

  private walk(view: View, node: ResolvedNode, visited = new Set<Id>()): ResolvedNode[] {
    if (visited.has(node.nodeId)) return [];
    visited.add(node.nodeId);
    return [node, ...this.entries(view, node).flatMap(({ child }) => this.walk(view, child, visited))];
  }

  private hasOpenDescendant(view: View, node: ResolvedNode, visited: Set<Id>): boolean {
    for (const { child } of this.entries(view, node)) {
      if (!terminal.has(child.record.attributes.status)) return true;
      if (!visited.has(child.nodeId)) {
        visited.add(child.nodeId);
        if (this.hasOpenDescendant(view, child, visited)) return true;
      }
    }
    return false;
  }

  private linkLocation(view: View, linkId: Id): LinkLocation | null {
    try {
      const link = this.records.resolveLinkRecord(linkId, view);
      return { parentNodeId: link.parentNodeId, name: link.name };
    } catch (error) {
      if (error instanceof RepositoryError && error.code === "not_found") return null;
      throw error;
    }
  }

  private semanticChanges(
    view: View,
    previous: { view: View; node: ResolvedNode; location: LinkLocation | null } | null,
    current: { node: ResolvedNode; location: LinkLocation | null },
  ): Array<"work" | "children" | "renamed" | "moved"> {
    if (previous === null) return ["work", "children"];
    const changes: Array<"work" | "children" | "renamed" | "moved"> = [];
    if (JSON.stringify(previous.node.record.attributes) !== JSON.stringify(current.node.record.attributes)) changes.push("work");
    const beforeChildren = this.entries(previous.view, previous.node).map((entry) => [entry.child.linkId, entry.name]);
    const afterChildren = this.entries(view, current.node).map((entry) => [entry.child.linkId, entry.name]);
    if (JSON.stringify(beforeChildren) !== JSON.stringify(afterChildren)) changes.push("children");
    if (previous.location !== null && current.location !== null) {
      if (previous.location.parentNodeId === current.location.parentNodeId && previous.location.name !== current.location.name) changes.push("renamed");
      if (previous.location.parentNodeId !== current.location.parentNodeId) changes.push("moved");
    }
    return changes;
  }

  private resolveMoveDestination(resolved: ResolvedSession, rawDestination: string, sourceName: string): { parent: ResolvedNode; name: string } {
    try {
      return { parent: this.resolvePath(resolved, rawDestination), name: sourceName };
    } catch (error) {
      if (!(error instanceof RepositoryError) || error.code !== "not_found") throw error;
    }
    const absolute = rawDestination.startsWith("/");
    const segments = this.parsePath(rawDestination);
    const final = segments.pop();
    if (final === undefined || (!final.escaped && (final.value === "." || final.value === ".."))) {
      throw new RepositoryError("invariant", "destination must name a directory or new entry");
    }
    const parentPath = (absolute ? "/" : "") + segments.map((segment) => this.escapeName(segment.value)).join("/");
    return { parent: this.resolvePath(resolved, parentPath || (absolute ? "/" : ".")), name: this.normalizeName(final.value) };
  }

  private ensureMoveName(view: View, parent: ResolvedNode, sourceLinkId: Id, name: string): void {
    if (this.entries(view, parent).some((entry) => entry.child.linkId !== sourceLinkId && entry.name === name)) {
      throw new RepositoryError("conflict", "directory already contains: " + name);
    }
  }

  private ensureNameAvailable(entries: Array<{ name: string }>, name: string): void {
    if (entries.some((entry) => entry.name === name)) throw new RepositoryError("conflict", "directory already contains: " + name);
  }

  private repairMovedCursor(cursor: Id[], source: Id[], destination: Id[]): Id[] {
    return this.startsWith(cursor, source) ? [...destination, ...cursor.slice(source.length)] : cursor;
  }

  private startsWith(value: Id[], prefix: Id[]): boolean {
    return prefix.every((part, index) => value[index] === part);
  }

  private parsePath(rawPath: string): PathSegment[] {
    const segments: PathSegment[] = [];
    let current = "";
    let escaped = false;
    let hasEscape = false;
    for (const character of rawPath) {
      if (escaped) {
        current += character;
        escaped = false;
        hasEscape = true;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "/") {
        if (current) segments.push({ value: this.normalizeName(current), escaped: hasEscape });
        current = "";
        hasEscape = false;
      } else {
        current += character;
      }
    }
    if (escaped) throw new RepositoryError("invariant", "path ends with an escape");
    if (current) segments.push({ value: this.normalizeName(current), escaped: hasEscape });
    return segments;
  }

  private normalizeName(value: string): string {
    const name = value.normalize("NFC");
    if (!name || name.includes("\0")) throw new RepositoryError("invariant", "entry name must be non-empty and contain no NUL");
    return name;
  }

  private escapeName(name: string): string {
    const escaped = name.replaceAll("\\", "\\\\").replaceAll("/", "\\/");
    return escaped === "." || escaped === ".." ? "\\" + escaped : escaped;
  }

  private emptyWork(): WorkFields {
    return WorkFieldsSchema.parse({});
  }

  private mergeWork(base: WorkFields, patch: WorkPatch): WorkFields {
    return WorkFieldsSchema.parse({ ...base, ...patch });
  }

  private timestamp(): string {
    return new Date().toISOString();
  }
}
