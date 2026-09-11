import { z } from "zod";
import {
  ContinuationModel,
  type ModelMutation,
} from "./continuation-model.js";
import {
  RepositoryError,
  SqliteRecordRepository,
  type RecordRepository,
  type SessionState,
} from "./record-repository.js";
import {
  OperationSchemas,
  PROTOCOL_VERSION,
  ContextSchema,
  ProposalSchema,
  schemaDigest,
  type Context,
  type OperationName,
  type Proposal,
  type RpcResponse,
} from "./schema.js";

/**
 * Application controller for every daemon operation.
 *
 * Transport validation remains in dispatch; all state-changing commands are
 * committed here as one repository transaction with a command receipt.
 */
export class ContinuationController {
  private readonly model: ContinuationModel;

  constructor(
    private readonly records: RecordRepository = new SqliteRecordRepository(),
  ) {
    this.model = new ContinuationModel(records);
  }

  describe(): {
    protocolVersion: typeof PROTOCOL_VERSION;
    schemaDigest: string;
    operations: Array<{
      name: string;
      inputSchema: unknown;
      outputSchema: unknown;
    }>;
  } {
    return {
      protocolVersion: PROTOCOL_VERSION,
      schemaDigest,
      operations: Object.entries(OperationSchemas).map(([name, operation]) => ({
        name,
        inputSchema: z.toJSONSchema(operation.input),
        outputSchema: z.toJSONSchema(operation.output),
      })),
    };
  }

  dispatch(name: OperationName, raw: unknown): unknown {
    const result = this.dispatchValidated(name, raw);
    return OperationSchemas[name].output.parse(result);
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

    return {
      protocolVersion: PROTOCOL_VERSION,
      id,
      ok: false,
      error: { code, message },
    };
  }

  private dispatchValidated(name: OperationName, raw: unknown): unknown {
    switch (name) {
      case "hello":
        return this.hello(raw);
      case "describe":
        OperationSchemas.describe.input.parse(raw);
        return this.describe();
      case "registerSession":
        return this.registerSession(raw);
      case "getContext":
        return this.getContext(raw);
      case "searchContext":
        return this.searchContext(raw);
      case "searchHistory":
        return this.searchHistory(raw);
      case "pushChild":
        return this.pushChild(raw);
      case "addSibling":
        return this.addSibling(raw);
      case "enter":
        return this.enter(raw);
      case "back":
        return this.back(raw);
      case "updateRecord":
        return this.updateRecord(raw);
      case "closeRecord":
        return this.closeRecord(raw);
      case "forkSession":
        return this.forkSession(raw);
      case "createProposal":
        return this.createProposal(raw);
      case "listProposals":
        return this.listProposals(raw);
      case "decideProposal":
        return this.decideProposal(raw);
    }
  }

  private hello(raw: unknown): unknown {
    const input = OperationSchemas.hello.input.parse(raw);

    if (input.schemaDigest !== schemaDigest) {
      throw new Error("schema digest mismatch");
    }

    return {
      protocolVersion: PROTOCOL_VERSION,
      schemaDigest,
      daemon: "context-tree-v2",
    };
  }

  private registerSession(raw: unknown): Context {
    const input = OperationSchemas.registerSession.input.parse(raw);

    return this.command(
      input.sessionId,
      input.commandId,
      ContextSchema,
      () => {
        if (this.records.findSession(input.sessionId)) {
          return this.model.context(input.sessionId);
        }

        const created = this.model.createRootSession(input.sessionId, input.cwd);

        if (!this.records.findWorkspaceByPath(created.workspace.canonicalPath)) {
          this.records.insertWorkspace(created.workspace);
        }

        this.records.insertSession(created.session);
        this.records.saveCursor(created.cursor);
        this.records.appendJournal({
          sessionId: input.sessionId,
          operation: "registerSession",
          previousSnapshotId: null,
          nextSnapshotId: created.session.headSnapshotId,
          cursorPath: created.cursor.inodePath,
          commandId: input.commandId,
          payload: {},
        });

        return this.model.context(input.sessionId);
      },
    );
  }

  private getContext(raw: unknown): Context {
    const input = OperationSchemas.getContext.input.parse(raw);
    return this.model.context(input.sessionId);
  }

  private searchContext(raw: unknown) {
    const input = OperationSchemas.searchContext.input.parse(raw);
    return this.model.search(input.sessionId, input.query, input.scope);
  }

  private searchHistory(raw: unknown) {
    const input = OperationSchemas.searchHistory.input.parse(raw);
    return this.model.search(input.sessionId, input.query, "history");
  }

  private pushChild(raw: unknown): Context {
    const input = OperationSchemas.pushChild.input.parse(raw);

    return this.mutation(
      input.sessionId,
      input.commandId,
      "pushChild",
      (snapshot, cursor) =>
        this.model.push(snapshot, cursor, input.fields, false, input.enter),
    );
  }

  private addSibling(raw: unknown): Context {
    const input = OperationSchemas.addSibling.input.parse(raw);

    return this.mutation(
      input.sessionId,
      input.commandId,
      "addSibling",
      (snapshot, cursor) =>
        this.model.push(snapshot, cursor, input.fields, true, input.enter),
    );
  }

  private enter(raw: unknown): Context {
    const input = OperationSchemas.enter.input.parse(raw);

    return this.mutation(
      input.sessionId,
      input.commandId,
      "enter",
      (snapshot, cursor) => this.model.enter(snapshot, cursor, input.inodeId),
    );
  }

  private back(raw: unknown): Context {
    const input = OperationSchemas.back.input.parse(raw);

    return this.mutation(
      input.sessionId,
      input.commandId,
      "back",
      (snapshot, cursor) => this.model.back(snapshot, cursor),
    );
  }

  private updateRecord(raw: unknown): Context {
    const input = OperationSchemas.updateRecord.input.parse(raw);

    return this.mutation(
      input.sessionId,
      input.commandId,
      "updateRecord",
      (snapshot, cursor) =>
        this.model.update(snapshot, cursor, input.inodeId, input.patch),
    );
  }

  private closeRecord(raw: unknown): Context {
    const input = OperationSchemas.closeRecord.input.parse(raw);

    return this.mutation(
      input.sessionId,
      input.commandId,
      "closeRecord",
      (snapshot, cursor) =>
        this.model.close(
          snapshot,
          cursor,
          input.inodeId,
          input.summary,
          input.status,
          input.moveToParent,
        ),
    );
  }

  private forkSession(raw: unknown): Context {
    const input = OperationSchemas.forkSession.input.parse(raw);

    return this.command(
      input.sessionId,
      input.commandId,
      ContextSchema,
      () => {
        if (this.records.findSession(input.sessionId)) {
          return this.model.context(input.sessionId);
        }

        const source = this.model.forkSource(input.parentSessionId);
        const session: SessionState = {
          id: input.sessionId,
          workspaceId: source.workspaceId,
          headSnapshotId: source.headSnapshotId,
          parentSessionId: input.parentSessionId,
          createdAt: new Date().toISOString(),
        };
        const cursor = this.model.cursorFor(
          input.sessionId,
          source.headSnapshotId,
          source.cursorPath,
        );

        this.records.insertSession(session);
        this.records.saveCursor(cursor);
        this.records.appendJournal({
          sessionId: input.sessionId,
          operation: "forkSession",
          previousSnapshotId: null,
          nextSnapshotId: source.headSnapshotId,
          cursorPath: cursor.inodePath,
          commandId: input.commandId,
          payload: { parentSessionId: input.parentSessionId },
        });

        return this.model.context(input.sessionId);
      },
    );
  }

  private createProposal(raw: unknown): Proposal {
    const input = OperationSchemas.createProposal.input.parse(raw);

    return this.command(
      input.sessionId,
      input.commandId,
      ProposalSchema,
      () => {
        const session = this.records.getSession(input.sessionId);
        const cursor = this.records.getCursor(input.sessionId);
        const proposalDraft = this.model.createProposal(
          session,
          cursor,
          input.kind,
          input.inodeId,
          input.patch,
          input.candidateInodeId,
          input.sourceSessionId,
          input.sourceSnapshotId,
        );

        const proposal = this.records.insertProposal(proposalDraft);
        this.records.appendJournal({
          sessionId: input.sessionId,
          operation: "createProposal",
          previousSnapshotId: session.headSnapshotId,
          nextSnapshotId: session.headSnapshotId,
          cursorPath: cursor.inodePath,
          commandId: input.commandId,
          payload: { proposalId: proposal.id },
        });

        return proposal;
      },
    );
  }

  private listProposals(raw: unknown): Proposal[] {
    const input = OperationSchemas.listProposals.input.parse(raw);
    return this.records.listPendingProposals(input.sessionId);
  }

  private decideProposal(raw: unknown): Context {
    const input = OperationSchemas.decideProposal.input.parse(raw);

    return this.command(
      input.sessionId,
      input.commandId,
      ContextSchema,
      () => {
        const session = this.records.getSession(input.sessionId);
        const snapshot = this.records.getSnapshot(session.headSnapshotId);
        const cursor = this.records.getCursor(input.sessionId);
        const proposal = this.records.findPendingProposal(
          input.proposalId,
          input.sessionId,
        );

        if (!proposal) {
          throw new RepositoryError("not_found", "pending proposal not found");
        }

        const accepting = input.decision === "accept_existing" ||
          input.decision === "accept_replacement";

        if (accepting && proposal.sourceSnapshotId !== snapshot.id) {
          throw new RepositoryError(
            "conflict",
            "proposal is stale against the current session head",
          );
        }

        const decision = this.model.decideProposal(
          snapshot,
          cursor,
          proposal,
          input.decision,
          input.candidateInodeId,
          input.replacement,
        );
        this.records.updateProposalStatus(
          proposal.id,
          decision.proposalStatus,
          new Date().toISOString(),
        );

        if (!decision.mutation) {
          this.records.appendJournal({
            sessionId: input.sessionId,
            operation: "decideProposal",
            previousSnapshotId: snapshot.id,
            nextSnapshotId: snapshot.id,
            cursorPath: cursor.inodePath,
            commandId: input.commandId,
            payload: {
              proposalId: proposal.id,
              decision: input.decision,
            },
          });

          return this.model.context(input.sessionId);
        }

        return this.persistMutation(
          input.sessionId,
          input.commandId,
          "decideProposal",
          snapshot,
          decision.mutation,
        );
      },
    );
  }

  private mutation(
    sessionId: string,
    commandId: string | undefined,
    operation: string,
    useCase: (
      snapshot: ReturnType<RecordRepository["getSnapshot"]>,
      cursor: ReturnType<RecordRepository["getCursor"]>,
    ) => ModelMutation,
  ): Context {
    return this.command(
      sessionId,
      commandId,
      ContextSchema,
      () => {
        const session = this.records.getSession(sessionId);
        const snapshot = this.records.getSnapshot(session.headSnapshotId);
        const cursor = this.records.getCursor(sessionId);
        const result = useCase(snapshot, cursor);

        return this.persistMutation(
          sessionId,
          commandId,
          operation,
          snapshot,
          result,
        );
      },
    );
  }

  private persistMutation(
    sessionId: string,
    commandId: string | undefined,
    operation: string,
    previousSnapshot: ReturnType<RecordRepository["getSnapshot"]>,
    mutation: ModelMutation,
  ): Context {
    const nextSnapshot = mutation.nextRootDirectoryId === previousSnapshot.rootDirectoryId
      ? previousSnapshot
      : this.model.createSnapshot(
        mutation.nextRootDirectoryId,
        previousSnapshot.id,
      );

    if (nextSnapshot.id !== previousSnapshot.id) {
      this.records.updateSessionHead(sessionId, nextSnapshot.id);
    }

    const cursor = this.model.cursorFor(
      sessionId,
      nextSnapshot.id,
      mutation.nextCursorPath,
    );

    this.records.saveCursor(cursor);
    this.records.appendJournal({
      sessionId,
      operation,
      previousSnapshotId: previousSnapshot.id,
      nextSnapshotId: nextSnapshot.id,
      cursorPath: cursor.inodePath,
      commandId,
      payload: mutation.journalPayload,
    });

    return this.model.context(sessionId);
  }

  private command<T>(
    sessionId: string,
    commandId: string | undefined,
    resultSchema: z.ZodType<T>,
    work: () => T,
  ): T {
    return this.records.transaction(() => {
      if (commandId) {
        const receipt = this.records.findReceipt(sessionId, commandId);

        if (receipt !== undefined) {
          return resultSchema.parse(receipt);
        }
      }

      const result = work();

      if (commandId) {
        this.records.saveReceipt(sessionId, commandId, result);
      }

      return result;
    });
  }
}
