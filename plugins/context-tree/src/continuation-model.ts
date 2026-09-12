import { resolve } from "node:path";
import {
  ContextSchema,
  CursorSchema,
  PayloadFieldsSchema,
  type Context,
  type Cursor,
  type DirectoryInode,
  type InodeId,
  type PayloadFields,
  type PayloadInode,
  type Proposal,
  type Snapshot,
} from "./schema.js";
import {
  type RecordRepository,
  RepositoryError,
} from "./record-repository.js";
import type { SessionState, Workspace } from "./schema.js";

const terminalStatuses = new Set(["done", "abandoned", "superseded"]);

export type ModelMutation = {
  nextRootDirectoryId: InodeId;
  nextCursorPath: InodeId[];
  journalPayload: unknown;
};

export type NewSessionState = {
  workspace: Workspace;
  session: SessionState;
  cursor: Cursor;
};

export type ProposalDecision = {
  mutation: ModelMutation | undefined;
  proposalStatus: "applied" | "rejected" | "discarded";
};

export class ContinuationModel {
  constructor(private readonly records: RecordRepository) {}

  createRootSession(sessionId: string, cwd: string): NewSessionState {
    const canonicalPath = resolve(cwd).toLowerCase();
    const existingWorkspace = this.records.findWorkspaceByPath(canonicalPath);
    const workspace = existingWorkspace ?? this.records.insertWorkspace({
      canonicalPath,
      createdAt: this.timestamp(),
    });
    const root = this.createPayload(
      PayloadFieldsSchema.parse({
        kind: "root",
        title: "Session " + sessionId.slice(0, 12),
        objective: "Initialize the continuation objective.",
        returnCondition: "Set the root objective and return condition.",
        currentState: "New continuation session.",
      }),
      null,
    );
    const rootDirectory = this.createDirectory(root.id, [], null);
    const snapshot = this.createSnapshot(rootDirectory.id, null);
    const cursor = this.cursorFor(sessionId, snapshot.id, [root.id]);

    return {
      workspace,
      session: {
        id: sessionId,
        workspaceId: workspace.id,
        headSnapshotId: snapshot.id,
        parentSessionId: null,
        createdAt: this.timestamp(),
      },
      cursor,
    };
  }

  context(sessionId: string): Context {
    const session = this.records.getSession(sessionId);
    const snapshot = this.records.getSnapshot(session.headSnapshotId);
    const cursor = this.records.getCursor(sessionId);

    if (cursor.snapshotId !== snapshot.id) {
      throw new RepositoryError(
        "invariant",
        "cursor snapshot differs from session head",
      );
    }

    const resolvedPath = cursor.inodePath.map((inodeId) =>
      this.resolveLiveInode(snapshot.id, inodeId),
    );
    const currentId = resolvedPath[resolvedPath.length - 1];

    if (!currentId) {
      throw new RepositoryError("invariant", "cursor path must not be empty");
    }

    const currentDirectory = this.findDirectory(
      snapshot.rootDirectoryId,
      currentId,
    );

    if (!currentDirectory) {
      throw new RepositoryError(
        "invariant",
        "cursor target is not reachable from session head",
      );
    }

    const unresolved = this.payloadIds(snapshot.rootDirectoryId)
      .map((inodeId) => this.records.getPayload(inodeId))
      .filter((inode) => !terminalStatuses.has(inode.status));
    const ancestorBriefing = resolvedPath.map((inodeId) => {
      const directory = this.findDirectory(snapshot.rootDirectoryId, inodeId);

      if (!directory) {
        throw new RepositoryError(
          "invariant",
          "active ancestor is not reachable from session head",
        );
      }

      const childOutcomes = directory.entries
        .map((entry) => this.records.getDirectory(entry.directoryId))
        .map((childDirectory) =>
          this.records.getPayload(childDirectory.payloadId),
        )
        .filter((child) => terminalStatuses.has(child.status));

      return {
        record: this.records.getPayload(inodeId),
        childOutcomes,
      };
    });

    return ContextSchema.parse({
      sessionId,
      headSnapshotId: snapshot.id,
      current: this.records.getPayload(currentId),
      activePath: resolvedPath.map((inodeId) => this.records.getPayload(inodeId)),
      children: currentDirectory.entries.map((entry) => {
        const directory = this.records.getDirectory(entry.directoryId);
        return this.records.getPayload(directory.payloadId);
      }),
      pendingProposals: this.records.listPendingProposals(sessionId),
      unresolved,
      ancestorBriefing,
    });
  }

  push(
    snapshot: Snapshot,
    cursor: Cursor,
    fields: PayloadFields,
    sibling: boolean,
    enter: boolean,
  ): ModelMutation {
    if (!fields.returnCondition) {
      throw new RepositoryError(
        "invariant",
        "returnCondition is required for independently returnable work",
      );
    }

    const parentPathIndex = sibling
      ? cursor.inodePath.length - 2
      : cursor.inodePath.length - 1;
    const requestedParent = cursor.inodePath[parentPathIndex];

    if (!requestedParent) {
      throw new RepositoryError("invariant", "root cannot have a sibling");
    }

    const parentId = this.resolveLiveInode(snapshot.id, requestedParent);
    const parentDirectory = this.findDirectory(
      snapshot.rootDirectoryId,
      parentId,
    );

    if (!parentDirectory) {
      throw new RepositoryError("not_found", "parent record is not reachable");
    }

    const child = this.createPayload(fields, null);
    const childDirectory = this.createDirectory(child.id, [], null);
    const rootDirectoryId = this.replaceDirectory(
      snapshot.rootDirectoryId,
      parentId,
      (directory) => {
        const entry = {
          position: directory.entries.length,
          directoryId: childDirectory.id,
        };

        return this.createDirectory(
          directory.payloadId,
          [...directory.entries, entry],
          directory,
        );
      },
    );

    return {
      nextRootDirectoryId: rootDirectoryId,
      nextCursorPath: enter
        ? [...cursor.inodePath, child.id]
        : cursor.inodePath,
      journalPayload: { child: child.id },
    };
  }

  enter(
    snapshot: Snapshot,
    cursor: Cursor,
    requestedInodeId: InodeId,
  ): ModelMutation {
    const currentId = this.resolveLiveInode(
      snapshot.id,
      this.currentPathId(cursor),
    );
    const targetId = this.resolveLiveInode(snapshot.id, requestedInodeId);
    const currentDirectory = this.findDirectory(
      snapshot.rootDirectoryId,
      currentId,
    );
    const isChild = currentDirectory?.entries.some((entry) => {
      const childDirectory = this.records.getDirectory(entry.directoryId);
      return childDirectory.payloadId === targetId;
    });

    if (!isChild) {
      throw new RepositoryError(
        "invariant",
        "target is not a direct child of the cursor record",
      );
    }

    return {
      nextRootDirectoryId: snapshot.rootDirectoryId,
      nextCursorPath: [...cursor.inodePath, targetId],
      journalPayload: { target: targetId },
    };
  }

  back(snapshot: Snapshot, cursor: Cursor): ModelMutation {
    const nextCursorPath = cursor.inodePath.length > 1
      ? cursor.inodePath.slice(0, -1)
      : cursor.inodePath;

    return {
      nextRootDirectoryId: snapshot.rootDirectoryId,
      nextCursorPath,
      journalPayload: {},
    };
  }

  update(
    snapshot: Snapshot,
    cursor: Cursor,
    requestedInodeId: InodeId | undefined,
    patch: Partial<PayloadFields>,
  ): ModelMutation {
    const targetId = this.resolveLiveInode(
      snapshot.id,
      requestedInodeId ?? this.currentPathId(cursor),
    );
    const before = this.records.getPayload(targetId);
    const replacement = this.createPayload(
      PayloadFieldsSchema.parse({
        ...this.payloadFields(before),
        ...patch,
      }),
      before,
    );
    const rootDirectoryId = this.replaceDirectory(
      snapshot.rootDirectoryId,
      targetId,
      (directory) => this.createDirectory(
        replacement.id,
        directory.entries,
        directory,
      ),
    );

    return {
      nextRootDirectoryId: rootDirectoryId,
      nextCursorPath: this.replaceInPath(
        cursor.inodePath,
        targetId,
        replacement.id,
      ),
      journalPayload: { replacement: replacement.id },
    };
  }

  close(
    snapshot: Snapshot,
    cursor: Cursor,
    requestedInodeId: InodeId | undefined,
    summary: string,
    status: "done" | "abandoned" | "superseded",
    moveToParent: boolean,
  ): ModelMutation {
    const targetId = this.resolveLiveInode(
      snapshot.id,
      requestedInodeId ?? this.currentPathId(cursor),
    );
    const directory = this.findDirectory(snapshot.rootDirectoryId, targetId);

    if (!directory) {
      throw new RepositoryError("not_found", "target record is not reachable");
    }

    const hasOpenDescendant = directory.entries.some((entry) =>
      this.payloadIds(entry.directoryId)
        .map((inodeId) => this.records.getPayload(inodeId))
        .some((inode) => !terminalStatuses.has(inode.status)),
    );

    if (hasOpenDescendant) {
      throw new RepositoryError(
        "invariant",
        "cannot close a record with non-terminal descendants",
      );
    }

    const before = this.records.getPayload(targetId);
    const replacement = this.createPayload(
      PayloadFieldsSchema.parse({
        ...this.payloadFields(before),
        currentState: summary,
        status,
      }),
      before,
    );
    const rootDirectoryId = this.replaceDirectory(
      snapshot.rootDirectoryId,
      targetId,
      (existingDirectory) => this.createDirectory(
        replacement.id,
        existingDirectory.entries,
        existingDirectory,
      ),
    );
    const replacedPath = this.replaceInPath(
      cursor.inodePath,
      targetId,
      replacement.id,
    );
    const nextCursorPath = moveToParent &&
      replacedPath[replacedPath.length - 1] === replacement.id &&
      replacedPath.length > 1
      ? replacedPath.slice(0, -1)
      : replacedPath;

    return {
      nextRootDirectoryId: rootDirectoryId,
      nextCursorPath,
      journalPayload: { replacement: replacement.id },
    };
  }

  forkSource(parentSessionId: string): {
    workspaceId: InodeId;
    headSnapshotId: InodeId;
    cursorPath: InodeId[];
  } {
    const parent = this.records.getSession(parentSessionId);
    const cursor = this.records.getCursor(parentSessionId);

    return {
      workspaceId: parent.workspaceId,
      headSnapshotId: parent.headSnapshotId,
      cursorPath: cursor.inodePath,
    };
  }

  createProposal(
    session: SessionState,
    cursor: Cursor,
    kind: Proposal["kind"],
    requestedInodeId: InodeId | undefined,
    patch: Partial<PayloadFields> | undefined,
    candidateInodeId: InodeId | undefined,
    sourceSessionId: string | undefined,
    sourceSnapshotId: InodeId | undefined,
  ): Omit<Proposal, "id"> {
    const sourceId = sourceSnapshotId ?? session.headSnapshotId;
    const targetId = this.resolveLiveInode(
      sourceId,
      requestedInodeId ?? this.currentPathId(cursor),
    );
    const base = this.records.getPayload(targetId);
    const candidateId = candidateInodeId ?? (
      patch
        ? this.createPayload(
          PayloadFieldsSchema.parse({
            ...this.payloadFields(base),
            ...patch,
          }),
          base,
        ).id
        : null
    );

    return {
      sessionId: session.id,
      sourceSessionId: sourceSessionId ?? null,
      sourceSnapshotId: sourceId,
      targetInodeId: targetId,
      candidateInodeId: candidateId,
      patch: patch ?? null,
      kind,
      status: "pending",
      createdAt: this.timestamp(),
      decidedAt: null,
    };
  }

  decideProposal(
    snapshot: Snapshot,
    cursor: Cursor,
    proposal: Proposal,
    decision: "accept_existing" | "accept_replacement" | "reject" | "discard",
    candidateInodeId: InodeId | undefined,
    replacementPatch: Partial<PayloadFields> | undefined,
  ): ProposalDecision {
    if (decision === "reject" || decision === "discard") {
      return {
        mutation: undefined,
        proposalStatus: decision === "reject" ? "rejected" : "discarded",
      };
    }

    const targetId = this.resolveLiveInode(snapshot.id, proposal.targetInodeId);
    const current = this.records.getPayload(targetId);
    const chosen = decision === "accept_existing"
      ? this.selectCandidate(candidateInodeId ?? proposal.candidateInodeId)
      : this.createPayload(
        PayloadFieldsSchema.parse({
          ...this.payloadFields(current),
          ...replacementPatch,
        }),
        current,
      );
    const rootDirectoryId = this.replaceDirectory(
      snapshot.rootDirectoryId,
      targetId,
      (directory) => this.createDirectory(chosen.id, directory.entries, directory),
    );

    return {
      mutation: {
        nextRootDirectoryId: rootDirectoryId,
        nextCursorPath: this.replaceInPath(
          cursor.inodePath,
          targetId,
          chosen.id,
        ),
        journalPayload: {
          proposalId: proposal.id,
          chosen: chosen.id,
        },
      },
      proposalStatus: "applied",
    };
  }

  search(
    sessionId: string,
    query: string,
    scope: "active_path" | "session_tree" | "workspace" | "global" | "history",
  ): PayloadInode[] {
    const context = this.context(sessionId);
    const normalizedQuery = query.toLowerCase();
    const contains = (inode: PayloadInode): boolean => {
      const searchableText = [
        inode.title,
        inode.objective,
        inode.rationale,
        inode.currentState,
        ...inode.openQuestions,
        inode.returnCondition,
        JSON.stringify(inode.refs),
        JSON.stringify(inode.metadata),
      ].join("\n").toLowerCase();

      return searchableText.includes(normalizedQuery);
    };

    if (scope === "active_path") {
      return context.activePath.filter(contains);
    }

    const ids = this.searchIds(sessionId, context, scope);

    return ids
      .map((inodeId) => this.records.getPayload(inodeId))
      .filter(contains)
      .slice(0, 20);
  }

  createSnapshot(
    rootDirectoryId: InodeId,
    parentSnapshotId: InodeId | null,
  ): Snapshot {
    return this.records.insertSnapshot({
      rootDirectoryId,
      parentSnapshotId,
      createdAt: this.timestamp(),
    });
  }

  cursorFor(
    sessionId: string,
    snapshotId: InodeId,
    inodePath: InodeId[],
  ): Cursor {
    return CursorSchema.parse({
      sessionId,
      snapshotId,
      inodePath,
      updatedAt: this.timestamp(),
    });
  }

  private searchIds(
    sessionId: string,
    context: Context,
    scope: "session_tree" | "workspace" | "global" | "history",
  ): InodeId[] {
    if (scope === "session_tree") {
      const snapshot = this.records.getSnapshot(context.headSnapshotId);
      return this.payloadIds(snapshot.rootDirectoryId);
    }

    if (scope === "history") {
      return this.records.listAllPayloadIds();
    }

    const session = this.records.getSession(sessionId);
    const snapshotIds = scope === "workspace"
      ? this.records.listSessionHeadSnapshotIds(session.workspaceId)
      : this.records.listSessionHeadSnapshotIds();
    const ids = snapshotIds.flatMap((snapshotId) => {
      const snapshot = this.records.getSnapshot(snapshotId);
      return this.payloadIds(snapshot.rootDirectoryId);
    });

    return [...new Set(ids)];
  }

  private createPayload(
    fields: PayloadFields,
    predecessor: PayloadInode | null,
  ): PayloadInode {
    return this.records.insertPayload({
      ...fields,
      predecessorId: predecessor?.id ?? null,
      historyVersion: predecessor ? predecessor.historyVersion + 1 : 0,
      createdAt: this.timestamp(),
    });
  }

  private createDirectory(
    payloadId: InodeId,
    entries: DirectoryInode["entries"],
    predecessor: DirectoryInode | null,
  ): DirectoryInode {
    return this.records.insertDirectory({
      predecessorId: predecessor?.id ?? null,
      historyVersion: predecessor ? predecessor.historyVersion + 1 : 0,
      payloadId,
      entries,
      createdAt: this.timestamp(),
    });
  }

  private payloadIds(
    directoryId: InodeId,
    output: InodeId[] = [],
  ): InodeId[] {
    const directory = this.records.getDirectory(directoryId);
    output.push(directory.payloadId);

    for (const entry of directory.entries) {
      this.payloadIds(entry.directoryId, output);
    }

    return output;
  }

  private findDirectory(
    directoryId: InodeId,
    payloadId: InodeId,
  ): DirectoryInode | undefined {
    const directory = this.records.getDirectory(directoryId);

    if (directory.payloadId === payloadId) {
      return directory;
    }

    for (const entry of directory.entries) {
      const found = this.findDirectory(entry.directoryId, payloadId);

      if (found) {
        return found;
      }
    }

    return undefined;
  }

  private replaceDirectory(
    rootDirectoryId: InodeId,
    targetPayloadId: InodeId,
    apply: (directory: DirectoryInode) => DirectoryInode,
  ): InodeId {
    const walk = (directoryId: InodeId): {
      directoryId: InodeId;
      changed: boolean;
    } => {
      const directory = this.records.getDirectory(directoryId);

      if (directory.payloadId === targetPayloadId) {
        return {
          directoryId: apply(directory).id,
          changed: true,
        };
      }

      let changed = false;
      const entries = directory.entries.map((entry) => {
        const result = walk(entry.directoryId);
        changed ||= result.changed;

        return result.changed
          ? { ...entry, directoryId: result.directoryId }
          : entry;
      });

      if (!changed) {
        return {
          directoryId: directory.id,
          changed: false,
        };
      }

      return {
        directoryId: this.createDirectory(directory.payloadId, entries, directory).id,
        changed: true,
      };
    };
    const result = walk(rootDirectoryId);

    if (!result.changed) {
      throw new RepositoryError(
        "not_found",
        "inode is not reachable from this root snapshot",
      );
    }

    return result.directoryId;
  }

  private resolveLiveInode(
    snapshotId: InodeId,
    requestedInodeId: InodeId,
  ): InodeId {
    const snapshot = this.records.getSnapshot(snapshotId);
    const currentIds = this.payloadIds(snapshot.rootDirectoryId);

    if (currentIds.includes(requestedInodeId)) {
      return requestedInodeId;
    }

    const successors = currentIds.filter((inodeId) => {
      let inode = this.records.getPayload(inodeId);
      const seen = new Set<InodeId>();

      while (inode.predecessorId && !seen.has(inode.id)) {
        seen.add(inode.id);

        if (inode.predecessorId === requestedInodeId) {
          return true;
        }

        inode = this.records.getPayload(inode.predecessorId);
      }

      return false;
    });

    if (successors.length !== 1) {
      throw new RepositoryError(
        "conflict",
        "inode has no unique successor reachable from session head",
      );
    }

    return successors[0];
  }

  private payloadFields(inode: PayloadInode): PayloadFields {
    return PayloadFieldsSchema.parse({
      kind: inode.kind,
      title: inode.title,
      objective: inode.objective,
      rationale: inode.rationale,
      currentState: inode.currentState,
      openQuestions: inode.openQuestions,
      returnCondition: inode.returnCondition,
      refs: inode.refs,
      metadata: inode.metadata,
      status: inode.status,
    });
  }

  private selectCandidate(candidateId: InodeId | null): PayloadInode {
    if (candidateId === null) {
      throw new RepositoryError(
        "invariant",
        "accept_existing requires a candidate inode",
      );
    }

    return this.records.getPayload(candidateId);
  }

  private replaceInPath(
    path: InodeId[],
    targetId: InodeId,
    replacementId: InodeId,
  ): InodeId[] {
    return path.map((inodeId) =>
      inodeId === targetId ? replacementId : inodeId,
    );
  }

  private currentPathId(cursor: Cursor): InodeId {
    const currentId = cursor.inodePath[cursor.inodePath.length - 1];

    if (!currentId) {
      throw new RepositoryError("invariant", "cursor path must not be empty");
    }

    return currentId;
  }

  private timestamp(): string {
    return new Date().toISOString();
  }
}
