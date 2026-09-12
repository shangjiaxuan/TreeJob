import { platform } from "node:os";
import { resolve } from "node:path";
import {
  RepositoryError,
  type Cursor,
  type DirectoryRevision,
  type EntryRevision,
  type Membership,
  type NodeRevision,
  type PayloadRevision,
  type Proposal,
  type RecordRepository,
  type Session,
  type Snapshot,
  type Workspace,
} from "./record-repository.js";
import {
  WorkFieldsSchema,
  IdSchema,
  type Id,
  type ProposalDecision,
  type ProposalKind,
  type RecordStatus,
  type WorkFields,
  type WorkPatch,
} from "./schema.js";

const terminal = new Set<RecordStatus>(["done", "abandoned", "superseded"]);

export type ResolvedNode = {
  nodeRevision: NodeRevision;
  payload: PayloadRevision;
  directory: DirectoryRevision;
  memberships: Membership[];
  entryPath: Id[];
  names: string[];
};

export type ResolvedSession = {
  session: Session;
  snapshot: Snapshot;
  cursor: Cursor;
  nodes: ResolvedNode[];
};

export type ProposalMutation =
  | {
    kind: "unchanged";
    cursorEntryPath: Id[];
    status: "rejected" | "discarded";
  }
  | {
    kind: "snapshot";
    rootNodeRevisionId: Id;
    cursorEntryPath: Id[];
    status: "applied";
  };

type DirectoryEdit = {
  remove: Set<Id>;
  add: Membership[];
};

type PathSegment = {
  value: string;
  escaped: boolean;
};

export class ContinuationModel {
  constructor(private readonly records: RecordRepository) {}

  createSession(sessionId: string, cwd: string): ResolvedSession {
    const canonicalPath = this.canonicalWorkspacePath(cwd);
    const workspace = this.records.findWorkspace(canonicalPath) ??
      this.records.insertWorkspace(canonicalPath);
    const root = this.createNode({
      kind: "node",
      title: "",
      objective: "",
      rationale: "",
      currentState: "New continuation session.",
      openQuestions: [],
      returnCondition: "",
      refs: [],
      metadata: {},
      status: "open",
    });
    const snapshot = this.records.insertSnapshot(root.id, null);
    const session: Session = {
      id: sessionId,
      workspaceId: workspace.id,
      headSnapshotId: snapshot.id,
      parentSessionId: null,
      createdAt: this.timestamp(),
    };
    const cursor: Cursor = {
      sessionId,
      snapshotId: snapshot.id,
      entryPath: [],
      updatedAt: this.timestamp(),
    };

    this.records.insertSession(session);
    this.records.saveCursor(cursor);
    return this.resolveSession(sessionId);
  }

  validateWorkspace(session: Session, cwd: string): void {
    const workspace = this.records.getWorkspace(session.workspaceId);
    const supplied = this.canonicalWorkspacePath(cwd);

    if (workspace.canonicalPath !== supplied) {
      throw new RepositoryError("conflict", "session is already bound to a different workspace");
    }
  }

  resolveSession(sessionId: string): ResolvedSession {
    const session = this.records.getSession(sessionId);
    const snapshot = this.records.getSnapshot(session.headSnapshotId);
    const cursor = this.records.getCursor(sessionId);

    if (cursor.snapshotId !== snapshot.id) {
      throw new RepositoryError("invariant", "cursor does not match session head");
    }

    const nodes: ResolvedNode[] = [];
    let nodeRevision = this.records.getNodeRevision(snapshot.rootNodeRevisionId);
    let names: string[] = [];
    nodes.push(this.resolved(nodeRevision, [], names));

    for (const entryId of cursor.entryPath) {
      const parent = nodes[nodes.length - 1];
      if (!parent) throw new RepositoryError("invariant", "missing cursor parent");
      const membership = parent.memberships.find((member) =>
        this.records.getEntryRevision(member.entryRevisionId).entryId === entryId
      );
      if (!membership) {
        throw new RepositoryError("conflict", "cursor entry is not reachable from session head");
      }
      const entry = this.records.getEntryRevision(membership.entryRevisionId);
      nodeRevision = this.records.getNodeRevision(membership.childNodeRevisionId);
      names = [...names, entry.name];
      nodes.push(this.resolved(nodeRevision, [...parent.entryPath, entryId], names));
    }

    return { session, snapshot, cursor, nodes };
  }

  resolvePath(resolved: ResolvedSession, rawPath: string): ResolvedNode {
    if (rawPath === ".") {
      return this.current(resolved);
    }

    const absolute = rawPath.startsWith("/");
    const segments = this.parsePath(rawPath);
    let nodes = absolute
      ? [this.valueAt(resolved.nodes, 0, "session has no root node")]
      : [...resolved.nodes];

    for (const segment of segments) {
      if (!segment.escaped && segment.value === ".") continue;
      if (!segment.escaped && segment.value === "..") {
        if (nodes.length > 1) nodes.pop();
        continue;
      }
      const parent = nodes[nodes.length - 1];
      if (!parent) throw new RepositoryError("invariant", "path has no root");
      const membership = parent.memberships.find((member) =>
        this.records.getEntryRevision(member.entryRevisionId).name === segment.value
      );
      if (!membership) throw new RepositoryError("not_found", "path not found: " + rawPath);
      const entry = this.records.getEntryRevision(membership.entryRevisionId);
      nodes.push(this.resolved(
        this.records.getNodeRevision(membership.childNodeRevisionId),
        [...parent.entryPath, entry.entryId],
        [...parent.names, entry.name],
      ));
    }

    return this.valueAt(nodes, nodes.length - 1, "path has no root node");
  }

  mkdir(resolved: ResolvedSession, name: string, patch: WorkPatch): {
    rootNodeRevisionId: Id;
    cursorEntryPath: Id[];
  } {
    const normalizedName = this.normalizeName(name);
    const parent = this.current(resolved);
    this.ensureNameAvailable(parent.memberships, normalizedName);
    const child = this.createNode(this.mergeWork(this.emptyWork(), patch));
    const entryId = this.records.createEntry(child.nodeId);
    const entry = this.records.insertEntryRevision(entryId, null, normalizedName);
    const rootNodeRevisionId = this.rewriteDirectories(
      resolved.snapshot.rootNodeRevisionId,
      new Map([[this.pathKey(parent.entryPath), {
        remove: new Set<Id>(),
        add: [{
          position: parent.memberships.length,
          entryRevisionId: entry.id,
          childNodeRevisionId: child.id,
        }],
      }]]),
    );
    return { rootNodeRevisionId, cursorEntryPath: resolved.cursor.entryPath };
  }

  edit(resolved: ResolvedSession, patch: WorkPatch): {
    rootNodeRevisionId: Id;
    cursorEntryPath: Id[];
  } {
    const current = this.current(resolved);
    const nextPayload = this.records.insertPayloadRevision(
      current.nodeRevision.nodeId,
      current.payload,
      this.mergeWork(this.work(current.payload), patch),
    );
    const replacement = this.records.insertNodeRevision(
      current.nodeRevision.nodeId,
      current.nodeRevision,
      nextPayload.id,
      current.directory.id,
    );
    return {
      rootNodeRevisionId: this.replaceNodeAtPath(
        resolved.snapshot.rootNodeRevisionId,
        current.entryPath,
        replacement.id,
      ),
      cursorEntryPath: resolved.cursor.entryPath,
    };
  }

  cd(resolved: ResolvedSession, path: string): {
    rootNodeRevisionId: Id;
    cursorEntryPath: Id[];
  } {
    const target = this.resolvePath(resolved, path);
    return {
      rootNodeRevisionId: resolved.snapshot.rootNodeRevisionId,
      cursorEntryPath: target.entryPath,
    };
  }

  close(resolved: ResolvedSession, summary: string, status: "done" | "abandoned" | "superseded"): {
    rootNodeRevisionId: Id;
    cursorEntryPath: Id[];
  } {
    const current = this.current(resolved);
    if (this.hasOpenDescendant(current.nodeRevision.id)) {
      throw new RepositoryError("invariant", "cannot close a node with non-terminal descendants");
    }
    const nextPayload = this.records.insertPayloadRevision(
      current.nodeRevision.nodeId,
      current.payload,
      this.mergeWork(this.work(current.payload), { currentState: summary, status }),
    );
    const replacement = this.records.insertNodeRevision(
      current.nodeRevision.nodeId,
      current.nodeRevision,
      nextPayload.id,
      current.directory.id,
    );
    return {
      rootNodeRevisionId: this.replaceNodeAtPath(
        resolved.snapshot.rootNodeRevisionId,
        current.entryPath,
        replacement.id,
      ),
      cursorEntryPath: current.entryPath.length > 0
        ? current.entryPath.slice(0, -1)
        : current.entryPath,
    };
  }

  move(resolved: ResolvedSession, sourcePath: string, destinationPath: string): {
    rootNodeRevisionId: Id;
    cursorEntryPath: Id[];
  } {
    const source = this.resolvePath(resolved, sourcePath);
    if (source.entryPath.length === 0) {
      throw new RepositoryError("invariant", "cannot move the root node");
    }
    const sourceParentPath = source.entryPath.slice(0, -1);
    const sourceEntryId = this.valueAt(
      source.entryPath,
      source.entryPath.length - 1,
      "source entry is missing",
    );
    const sourceParent = this.resolveEntryPath(resolved, sourceParentPath);
    const sourceMembership = sourceParent.memberships.find((membership) =>
      this.records.getEntryRevision(membership.entryRevisionId).entryId === sourceEntryId
    );
    if (!sourceMembership) throw new RepositoryError("invariant", "source membership not found");
    const sourceEntry = this.records.getEntryRevision(sourceMembership.entryRevisionId);

    const destination = this.resolveMoveDestination(resolved, destinationPath, sourceEntry.name);
    if (this.startsWith(destination.parent.entryPath, source.entryPath)) {
      throw new RepositoryError("invariant", "cannot move a node into itself or its descendant");
    }
    const sameParent = this.pathKey(sourceParentPath) === this.pathKey(destination.parent.entryPath);
    const existing = destination.parent.memberships.filter((membership) =>
      this.records.getEntryRevision(membership.entryRevisionId).entryId !== sourceEntryId
    );
    this.ensureNameAvailable(existing, destination.name);

    const entryRevision = destination.name === sourceEntry.name
      ? sourceEntry
      : this.records.insertEntryRevision(sourceEntry.entryId, sourceEntry, destination.name);
    const edits = new Map<string, DirectoryEdit>();
    this.addDirectoryEdit(edits, sourceParentPath, { remove: new Set([sourceEntryId]), add: [] });
    this.addDirectoryEdit(edits, destination.parent.entryPath, {
      remove: sameParent ? new Set<Id>() : new Set<Id>(),
      add: [{
        position: destination.parent.memberships.length,
        entryRevisionId: entryRevision.id,
        childNodeRevisionId: sourceMembership.childNodeRevisionId,
      }],
    });

    const rootNodeRevisionId = this.rewriteDirectories(
      resolved.snapshot.rootNodeRevisionId,
      edits,
    );
    const cursorEntryPath = this.repairMovedCursor(
      resolved.cursor.entryPath,
      source.entryPath,
      [...destination.parent.entryPath, sourceEntryId],
    );
    return { rootNodeRevisionId, cursorEntryPath };
  }

  fork(resolved: ResolvedSession, newSessionId: string): ResolvedSession {
    if (this.records.findSession(newSessionId)) {
      return this.resolveSession(newSessionId);
    }
    const session: Session = {
      id: newSessionId,
      workspaceId: resolved.session.workspaceId,
      headSnapshotId: resolved.snapshot.id,
      parentSessionId: resolved.session.id,
      createdAt: this.timestamp(),
    };
    const cursor: Cursor = {
      sessionId: newSessionId,
      snapshotId: resolved.snapshot.id,
      entryPath: resolved.cursor.entryPath,
      updatedAt: this.timestamp(),
    };
    this.records.insertSession(session);
    this.records.saveCursor(cursor);
    return this.resolveSession(newSessionId);
  }

  createProposal(
    resolved: ResolvedSession,
    kind: ProposalKind,
    patch: WorkPatch | null,
    sourceSessionId: string | null,
  ): Proposal {
    const current = this.current(resolved);
    return this.records.insertProposal({
      sessionId: resolved.session.id,
      sourceSessionId,
      sourceSnapshotId: resolved.snapshot.id,
      targetNodeId: current.nodeRevision.nodeId,
      targetNodeRevisionId: current.nodeRevision.id,
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
      return {
        kind: "unchanged",
        cursorEntryPath: resolved.cursor.entryPath,
        status: decision === "reject" ? "rejected" : "discarded",
      };
    }
    if (proposal.sourceSnapshotId !== resolved.snapshot.id) {
      throw new RepositoryError("conflict", "proposal is stale against the current session head");
    }
    const current = this.current(resolved);
    if (current.nodeRevision.id !== proposal.targetNodeRevisionId) {
      throw new RepositoryError("conflict", "proposal target is no longer the current node");
    }
    const patch = decision === "accept" ? proposal.patch : replacement;
    if (!patch) throw new RepositoryError("invariant", "proposal decision requires a patch");
    const mutation = this.edit(resolved, patch);
    return { kind: "snapshot", ...mutation, status: "applied" };
  }

  listNodeRevisions(node: ResolvedNode): NodeRevision[] {
    const output: NodeRevision[] = [];
    let revision: NodeRevision | null = node.nodeRevision;
    while (revision) {
      output.push(revision);
      revision = revision.predecessorId
        ? this.records.getNodeRevision(revision.predecessorId)
        : null;
    }
    return output;
  }

  revisionOnLineage(node: ResolvedNode, revisionId: Id): NodeRevision {
    const found = this.listNodeRevisions(node).find((revision) =>
      revision.id === revisionId
    );
    if (!found || found.nodeId !== node.nodeRevision.nodeId) {
      throw new RepositoryError("not_found", "revision is not on the current node lineage");
    }
    return found;
  }

  countUnresolved(resolved: ResolvedSession): number {
    return this.walk(resolved.snapshot.rootNodeRevisionId).filter((node) =>
      !terminal.has(node.payload.status)
    ).length;
  }

  allNodes(resolved: ResolvedSession): ResolvedNode[] {
    return this.walk(resolved.snapshot.rootNodeRevisionId);
  }

  allNodesAt(rootNodeRevisionId: Id): ResolvedNode[] {
    return this.walk(rootNodeRevisionId);
  }

  allNodesBelow(node: ResolvedNode): ResolvedNode[] {
    return this.walk(node.nodeRevision.id, node.entryPath, node.names);
  }

  public work(payload: PayloadRevision): WorkFields {
    return WorkFieldsSchema.parse({
      kind: payload.kind,
      title: payload.title,
      objective: payload.objective,
      rationale: payload.rationale,
      currentState: payload.currentState,
      openQuestions: payload.openQuestions,
      returnCondition: payload.returnCondition,
      refs: payload.refs,
      metadata: payload.metadata,
      status: payload.status,
    });
  }

  public current(resolved: ResolvedSession): ResolvedNode {
    const current = resolved.nodes[resolved.nodes.length - 1];
    if (!current) throw new RepositoryError("invariant", "session has no root node");
    return current;
  }

  public entrySummaries(node: ResolvedNode): Array<{
    name: string;
    child: ResolvedNode;
  }> {
    return node.memberships.map((membership) => {
      const entry = this.records.getEntryRevision(membership.entryRevisionId);
      return {
        name: entry.name,
        child: this.resolved(
          this.records.getNodeRevision(membership.childNodeRevisionId),
          [...node.entryPath, entry.entryId],
          [...node.names, entry.name],
        ),
      };
    });
  }

  public path(node: ResolvedNode): string {
    return node.names.length === 0 ? "/" : "/" + node.names.map((name) =>
      this.escapeName(name)
    ).join("/");
  }

  public changes(revision: NodeRevision): Array<"payload" | "directory"> {
    if (!revision.predecessorId) return ["payload", "directory"];
    const previous = this.records.getNodeRevision(revision.predecessorId);
    const changes: Array<"payload" | "directory"> = [];
    if (previous.payloadRevisionId !== revision.payloadRevisionId) changes.push("payload");
    if (previous.directoryRevisionId !== revision.directoryRevisionId) changes.push("directory");
    return changes;
  }

  private createNode(fields: WorkFields): NodeRevision {
    const nodeId = this.records.createNode();
    const payload = this.records.insertPayloadRevision(nodeId, null, fields);
    const directory = this.records.insertDirectoryRevision(nodeId, null, []);
    return this.records.insertNodeRevision(nodeId, null, payload.id, directory.id);
  }

  private resolved(nodeRevision: NodeRevision, entryPath: Id[], names: string[]): ResolvedNode {
    return {
      nodeRevision,
      payload: this.records.getPayloadRevision(nodeRevision.payloadRevisionId),
      directory: this.records.getDirectoryRevision(nodeRevision.directoryRevisionId),
      memberships: this.records.listMemberships(nodeRevision.directoryRevisionId),
      entryPath,
      names,
    };
  }

  private resolveEntryPath(resolved: ResolvedSession, path: Id[]): ResolvedNode {
    const root = resolved.nodes[0];
    if (!root) throw new RepositoryError("invariant", "missing root");
    let current = root;
    for (const entryId of path) {
      const membership = current.memberships.find((item) =>
        this.records.getEntryRevision(item.entryRevisionId).entryId === entryId
      );
      if (!membership) throw new RepositoryError("not_found", "entry path is not reachable");
      const entry = this.records.getEntryRevision(membership.entryRevisionId);
      current = this.resolved(
        this.records.getNodeRevision(membership.childNodeRevisionId),
        [...current.entryPath, entryId],
        [...current.names, entry.name],
      );
    }
    return current;
  }

  private resolveMoveDestination(
    resolved: ResolvedSession,
    rawDestination: string,
    sourceName: string,
  ): { parent: ResolvedNode; name: string } {
    try {
      return {
        parent: this.resolvePath(resolved, rawDestination),
        name: sourceName,
      };
    } catch (error) {
      if (!(error instanceof RepositoryError) || error.code !== "not_found") throw error;
    }
    const absolute = rawDestination.startsWith("/");
    const segments = this.parsePath(rawDestination);
    const final = segments.pop();
    if (!final || (!final.escaped && (final.value === "." || final.value === ".."))) {
      throw new RepositoryError("invariant", "destination must name a directory or new entry");
    }
    const parentPath = (absolute ? "/" : "") + segments.map((segment) =>
      this.escapeName(segment.value)
    ).join("/");
    return {
      parent: this.resolvePath(resolved, parentPath || (absolute ? "/" : ".")),
      name: this.normalizeName(final.value),
    };
  }

  private rewriteDirectories(
    rootNodeRevisionId: Id,
    edits: Map<string, DirectoryEdit>,
  ): Id {
    const walk = (nodeRevisionId: Id, path: Id[]): Id => {
      const node = this.records.getNodeRevision(nodeRevisionId);
      const directory = this.records.getDirectoryRevision(node.directoryRevisionId);
      const memberships = this.records.listMemberships(directory.id);
      const childIds = new Set<Id>();
      for (const editPath of edits.keys()) {
        const parsed = this.keyPath(editPath);
        if (parsed.length > path.length && this.startsWith(parsed.slice(0, path.length), path)) {
          childIds.add(this.valueAt(parsed, path.length, "path edit is missing a child entry"));
        }
      }
      let changed = false;
      let next = memberships.map((membership) => {
        const entry = this.records.getEntryRevision(membership.entryRevisionId);
        if (!childIds.has(entry.entryId)) return membership;
        const childRevisionId = walk(
          membership.childNodeRevisionId,
          [...path, entry.entryId],
        );
        if (childRevisionId === membership.childNodeRevisionId) return membership;
        changed = true;
        return { ...membership, childNodeRevisionId: childRevisionId };
      });
      const local = edits.get(this.pathKey(path));
      if (local) {
        changed = true;
        next = next.filter((membership) => !local.remove.has(
          this.records.getEntryRevision(membership.entryRevisionId).entryId,
        ));
        next = [...next, ...local.add];
        this.ensureUniqueMembershipNames(next);
      }
      if (!changed) return nodeRevisionId;
      const nextDirectory = this.records.insertDirectoryRevision(
        node.nodeId,
        directory,
        next.map((membership, position) => ({ ...membership, position })),
      );
      return this.records.insertNodeRevision(
        node.nodeId,
        node,
        node.payloadRevisionId,
        nextDirectory.id,
      ).id;
    };
    return walk(rootNodeRevisionId, []);
  }

  private replaceNodeAtPath(rootNodeRevisionId: Id, entryPath: Id[], replacementId: Id): Id {
    if (entryPath.length === 0) {
      return replacementId;
    }

    const parentPath = entryPath.slice(0, -1);
    const targetEntryId = this.valueAt(
      entryPath,
      entryPath.length - 1,
      "replacement target is missing",
    );
    return this.replaceChild(
      rootNodeRevisionId,
      parentPath,
      targetEntryId,
      replacementId,
    );
  }

  private replaceChild(
    rootNodeRevisionId: Id,
    parentPath: Id[],
    entryId: Id,
    replacementId: Id,
  ): Id {
    const walk = (nodeRevisionId: Id, depth: number): Id => {
      const node = this.records.getNodeRevision(nodeRevisionId);
      const directory = this.records.getDirectoryRevision(node.directoryRevisionId);
      const memberships = this.records.listMemberships(directory.id);
      let changed = false;
      const next = memberships.map((membership) => {
        const entry = this.records.getEntryRevision(membership.entryRevisionId);
        if (depth === parentPath.length && entry.entryId === entryId) {
          changed = true;
          return { ...membership, childNodeRevisionId: replacementId };
        }
        if (depth < parentPath.length && entry.entryId === parentPath[depth]) {
          const child = walk(membership.childNodeRevisionId, depth + 1);
          if (child !== membership.childNodeRevisionId) {
            changed = true;
            return { ...membership, childNodeRevisionId: child };
          }
        }
        return membership;
      });
      if (!changed) return nodeRevisionId;
      const nextDirectory = this.records.insertDirectoryRevision(node.nodeId, directory, next);
      return this.records.insertNodeRevision(
        node.nodeId,
        node,
        node.payloadRevisionId,
        nextDirectory.id,
      ).id;
    };
    return walk(rootNodeRevisionId, 0);
  }

  private hasOpenDescendant(nodeRevisionId: Id): boolean {
    const node = this.records.getNodeRevision(nodeRevisionId);
    const memberships = this.records.listMemberships(node.directoryRevisionId);
    return memberships.some((membership) => {
      const child = this.records.getNodeRevision(membership.childNodeRevisionId);
      const payload = this.records.getPayloadRevision(child.payloadRevisionId);
      return !terminal.has(payload.status) || this.hasOpenDescendant(child.id);
    });
  }

  private walk(nodeRevisionId: Id, path: Id[] = [], names: string[] = []): ResolvedNode[] {
    const current = this.resolved(this.records.getNodeRevision(nodeRevisionId), path, names);
    return [
      current,
      ...current.memberships.flatMap((membership) => {
        const entry = this.records.getEntryRevision(membership.entryRevisionId);
        return this.walk(
          membership.childNodeRevisionId,
          [...path, entry.entryId],
          [...names, entry.name],
        );
      }),
    ];
  }

  private addDirectoryEdit(edits: Map<string, DirectoryEdit>, path: Id[], change: DirectoryEdit): void {
    const key = this.pathKey(path);
    const existing = edits.get(key);
    if (!existing) {
      edits.set(key, change);
      return;
    }
    change.remove.forEach((entryId) => existing.remove.add(entryId));
    existing.add.push(...change.add);
  }

  private repairMovedCursor(cursor: Id[], source: Id[], destination: Id[]): Id[] {
    if (!this.startsWith(cursor, source)) return cursor;
    return [...destination, ...cursor.slice(source.length)];
  }

  private ensureNameAvailable(memberships: Membership[], name: string): void {
    if (memberships.some((membership) =>
      this.records.getEntryRevision(membership.entryRevisionId).name === name
    )) {
      throw new RepositoryError("conflict", "directory already contains: " + name);
    }
  }

  private ensureUniqueMembershipNames(memberships: Membership[]): void {
    const names = new Set<string>();
    for (const membership of memberships) {
      const name = this.records.getEntryRevision(membership.entryRevisionId).name;
      if (names.has(name)) throw new RepositoryError("conflict", "directory already contains: " + name);
      names.add(name);
    }
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
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "/") {
        if (current) segments.push({ value: this.normalizeName(current), escaped: hasEscape });
        current = "";
        hasEscape = false;
        continue;
      }
      current += character;
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

  private pathKey(path: Id[]): string {
    return path.join(",");
  }

  private keyPath(key: string): Id[] {
    return key ? key.split(",").map((value) => IdSchema.parse(Number(value))) : [];
  }

  private startsWith(value: Id[], prefix: Id[]): boolean {
    return prefix.every((entry, index) => value[index] === entry);
  }

  private mergeWork(base: WorkFields, patch: WorkPatch): WorkFields {
    return WorkFieldsSchema.parse({ ...base, ...patch });
  }

  private emptyWork(): WorkFields {
    return WorkFieldsSchema.parse({});
  }

  private timestamp(): string {
    return new Date().toISOString();
  }

  private canonicalWorkspacePath(cwd: string): string {
    const absolutePath = resolve(cwd);
    return platform() === "win32" ? absolutePath.toLowerCase() : absolutePath;
  }

  private valueAt<T>(values: readonly T[], index: number, message: string): T {
    if (index < 0 || index >= values.length) {
      throw new RepositoryError("invariant", message);
    }

    return values[index];
  }
}
