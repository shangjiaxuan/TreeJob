/**
 * Authoritative continuation contracts.
 *
 * The build-time metadata generator reads these declarations with the
 * TypeScript compiler API. Tags express runtime facts that ordinary TypeScript
 * types cannot encode.
 */

/** @schema @int @positive */
export type InodeId = number;

/** @schema @datetime */
export type Timestamp = string;

/** @schema @minLength 1 */
export type NonEmptyString = string;

/** @schema */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** @schema */
export type RecordStatus =
  | "open"
  | "blocked"
  | "done"
  | "abandoned"
  | "superseded";

/** @schema @strict */
export interface Reference {
  /** @minLength 1 */
  label: string;
  value: JsonValue;
}

/** @schema @strict */
export interface PayloadFields {
  /** @minLength 1 @default task */
  kind: string;

  /** @minLength 1 */
  title: string;

  /** @default "" */
  objective: string;

  /** @default "" */
  rationale: string;

  /** @default "" */
  currentState: string;

  /** @default [] */
  openQuestions: string[];

  /** @default "" */
  returnCondition: string;

  /** @default [] */
  refs: Reference[];

  /** @default {} */
  metadata: Record<string, JsonValue>;

  /** @default open */
  status: RecordStatus;
}

/** @schema @strict */
export interface PayloadInode extends PayloadFields {
  id: InodeId;
  predecessorId: InodeId | null;

  /** @int @nonnegative */
  historyVersion: number;

  createdAt: Timestamp;
}

/** @schema @strict */
export interface DirectoryEntry {
  /** @int @nonnegative */
  position: number;

  directoryId: InodeId;
}

/** @schema @strict */
export interface DirectoryInode {
  id: InodeId;
  predecessorId: InodeId | null;

  /** @int @nonnegative */
  historyVersion: number;

  payloadId: InodeId;
  entries: DirectoryEntry[];
  createdAt: Timestamp;
}

/** @schema @strict */
export interface Snapshot {
  id: InodeId;
  rootDirectoryId: InodeId;
  parentSnapshotId: InodeId | null;
  createdAt: Timestamp;
}

/** @schema @strict */
export interface Workspace {
  id: InodeId;

  /** @minLength 1 */
  canonicalPath: string;

  createdAt: Timestamp;
}

/** @schema @strict */
export interface SessionState {
  /** @minLength 1 */
  id: string;

  workspaceId: InodeId;
  headSnapshotId: InodeId;

  /** @minLength 1 */
  parentSessionId: string | null;

  createdAt: Timestamp;
}

/** @schema @strict */
export interface Cursor {
  /** @minLength 1 */
  sessionId: string;

  snapshotId: InodeId;

  /** @minItems 1 */
  inodePath: InodeId[];

  updatedAt: Timestamp;
}

/** @schema */
export type ProposalKind = "compact" | "subagent_result" | "manual";

/** @schema */
export type ProposalStatus = "pending" | "applied" | "rejected" | "discarded";

/** @schema @strict */
export interface PayloadPatch {
  kind?: string;
  title?: string;
  objective?: string;
  rationale?: string;
  currentState?: string;
  openQuestions?: string[];
  returnCondition?: string;
  refs?: Reference[];
  metadata?: Record<string, JsonValue>;
  status?: RecordStatus;
}

/** @schema @strict */
export interface Proposal {
  id: InodeId;

  /** @minLength 1 */
  sessionId: string;

  sourceSessionId: NonEmptyString | null;

  sourceSnapshotId: InodeId;
  targetInodeId: InodeId;
  candidateInodeId: InodeId | null;
  patch: PayloadPatch | null;
  kind: ProposalKind;
  status: ProposalStatus;
  createdAt: Timestamp;
  decidedAt: Timestamp | null;
}

/** @schema @strict */
export interface AncestorBriefingEntry {
  record: PayloadInode;
  childOutcomes: PayloadInode[];
}

/** @schema @strict */
export interface Context {
  sessionId: string;
  headSnapshotId: InodeId;
  current: PayloadInode;
  activePath: PayloadInode[];
  children: PayloadInode[];
  pendingProposals: Proposal[];
  unresolved: PayloadInode[];
  ancestorBriefing: AncestorBriefingEntry[];
}

/** @schema */
export type SearchScope =
  | "active_path"
  | "session_tree"
  | "workspace"
  | "global";

/** @schema @strict */
export interface HelloInput {
  protocolVersion: 1;

  /** @minLength 1 */
  schemaDigest: string;
}

/** @schema @strict */
export interface HelloOutput {
  protocolVersion: 1;
  schemaDigest: string;
  daemon: string;
}

/** @schema @strict */
export interface DescribeOperation {
  name: string;
  inputSchema: JsonValue;
  outputSchema: JsonValue;
}

/** @schema @strict */
export interface DescribeOutput {
  protocolVersion: 1;
  schemaDigest: string;
  operations: DescribeOperation[];
}

/** @schema @strict */
export interface RegisterSessionInput {
  /** @minLength 1 */
  sessionId: string;

  /** @minLength 1 */
  cwd: string;

  /** @minLength 1 */
  commandId?: string;
}

/** @schema @strict */
export interface SessionInput {
  /** @minLength 1 */
  sessionId: string;
}

/** @schema @strict */
export interface CommandInput extends SessionInput {
  /** @minLength 1 */
  commandId?: string;
}

/** @schema @strict */
export interface SearchContextInput extends CommandInput {
  query: string;

  /** @default active_path */
  scope: SearchScope;
}

/** @schema @strict */
export interface PushInput extends CommandInput {
  fields: PayloadFields;

  /** @default true */
  enter: boolean;
}

/** @schema @strict */
export interface EnterInput extends CommandInput {
  inodeId: InodeId;
}

/** @schema @strict */
export interface UpdateRecordInput extends CommandInput {
  inodeId?: InodeId;
  patch: PayloadPatch;
}

/** @schema @strict */
export interface CloseRecordInput extends CommandInput {
  inodeId?: InodeId;

  /** @minLength 1 */
  summary: string;

  /** @default done */
  status: "done" | "abandoned" | "superseded";

  /** @default true */
  moveToParent: boolean;
}

/** @schema @strict */
export interface ForkSessionInput {
  /** @minLength 1 */
  sessionId: string;

  /** @minLength 1 */
  parentSessionId: string;

  /** @minLength 1 */
  commandId?: string;
}

/** @schema @strict */
export interface CreateProposalInput extends CommandInput {
  inodeId?: InodeId;
  kind: ProposalKind;
  patch?: PayloadPatch;
  candidateInodeId?: InodeId;

  /** @minLength 1 */
  sourceSessionId?: string;

  sourceSnapshotId?: InodeId;
}

/** @schema */
export type ProposalDecision =
  | "accept_existing"
  | "accept_replacement"
  | "reject"
  | "discard";

/** @schema @strict */
export interface DecideProposalInput extends CommandInput {
  proposalId: InodeId;
  decision: ProposalDecision;
  candidateInodeId?: InodeId;
  replacement?: PayloadPatch;
}

export interface OperationContracts {
  hello: {
    input: HelloInput;
    output: HelloOutput;
    command: false;
  };
  describe: {
    input: Record<string, never>;
    output: DescribeOutput;
    command: false;
  };
  registerSession: {
    input: RegisterSessionInput;
    output: Context;
    command: true;
  };
  getContext: {
    input: SessionInput;
    output: Context;
    command: false;
  };
  searchContext: {
    input: SearchContextInput;
    output: PayloadInode[];
    command: false;
  };
  searchHistory: {
    input: {
      sessionId: string;
      query: string;
    };
    output: PayloadInode[];
    command: false;
  };
  pushChild: {
    input: PushInput;
    output: Context;
    command: true;
  };
  addSibling: {
    input: PushInput;
    output: Context;
    command: true;
  };
  enter: {
    input: EnterInput;
    output: Context;
    command: true;
  };
  back: {
    input: CommandInput;
    output: Context;
    command: true;
  };
  updateRecord: {
    input: UpdateRecordInput;
    output: Context;
    command: true;
  };
  closeRecord: {
    input: CloseRecordInput;
    output: Context;
    command: true;
  };
  forkSession: {
    input: ForkSessionInput;
    output: Context;
    command: true;
  };
  createProposal: {
    input: CreateProposalInput;
    output: Proposal;
    command: true;
  };
  listProposals: {
    input: SessionInput;
    output: Proposal[];
    command: false;
  };
  decideProposal: {
    input: DecideProposalInput;
    output: Context;
    command: true;
  };
}

/** @schema */
export type OperationName = keyof OperationContracts;

/** @schema */
export type RpcErrorCode =
  | "validation"
  | "unsupported_protocol"
  | "not_found"
  | "conflict"
  | "invariant"
  | "internal";

/** @schema @strict */
export interface RpcError {
  code: RpcErrorCode;
  message: string;
  details?: JsonValue;
}

/** @schema @strict */
export interface RpcRequest {
  protocolVersion: 1;

  /** @minLength 1 */
  id: string;

  method: OperationName;
  params: JsonValue;
}

/** @schema @strict */
export interface RpcSuccess {
  protocolVersion: 1;
  id: string;
  ok: true;
  result: JsonValue;
}

/** @schema @strict */
export interface RpcFailure {
  protocolVersion: 1;
  id: string;
  ok: false;
  error: RpcError;
}

/** @schema */
export type RpcResponse = RpcSuccess | RpcFailure;
