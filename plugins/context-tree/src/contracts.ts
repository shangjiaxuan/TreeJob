/** @schema @int @positive */
export type Id = number;

/** @schema @datetime */
export type Timestamp = string;

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

/** @schema */
export type ProposalStatus = "pending" | "applied" | "rejected" | "discarded";

/** @schema */
export type ProposalKind = "compact" | "subagent_result" | "manual";

/** @schema */
export type ProposalDecision =
  | "accept"
  | "replace"
  | "reject"
  | "discard";

/** @schema */
export type SearchScope = "subtree" | "session" | "workspace" | "global" | "history";

/** @schema */
export type RevisionChange = "payload" | "directory";

/** @schema @strict */
export interface Reference {
  /** @minLength 1 */
  label: string;
  value: JsonValue;
}

/** @schema @strict */
export interface WorkFields {
  /** @default node */
  kind: string;

  /** @default "" */
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
export interface WorkPatch {
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
export interface CurrentDirectory {
  path: string;
  canGoBack: boolean;
}

/** @schema @strict */
export interface CurrentWork extends WorkFields {}

/** @schema @strict */
export interface CursorState {
  current_dir: CurrentDirectory;
}

/** @schema @strict */
export interface PwdState extends CursorState {
  current_work: CurrentWork;
}

/** @schema @strict */
export interface EntrySummary {
  name: string;
  kind: string;
  title: string;
  status: RecordStatus;
  hasChildren: boolean;
}

/** @schema @strict */
export interface NodeRevisionSummary {
  revisionId: Id;
  createdAt: Timestamp;
  changes: RevisionChange[];
}

/** @schema @strict */
export interface SearchMatch {
  path: string;
  name: string;
  work: CurrentWork;
}

/** @schema @strict */
export interface RevisionDetails {
  revision: NodeRevisionSummary;
  work: CurrentWork;
  entries: EntrySummary[];
}

/** @schema @strict */
export interface ProposalSummary {
  proposalId: Id;
  kind: ProposalKind;
  status: ProposalStatus;
  createdAt: Timestamp;
  sourceSessionId: string | null;
  patch: WorkPatch | null;
}

/** @schema @strict */
export interface BriefingEntry {
  path: string;
  work: CurrentWork;
  closedChildOutcomes: string[];
}

/** @schema @strict */
export interface BriefingResult extends CursorState {
  ancestry: BriefingEntry[];
  pendingProposalCount: number;
  unresolvedCount: number;
}

/** @schema @strict */
export interface ListResult extends CursorState {
  listedPath: string;
  entries: EntrySummary[];
}

/** @schema @strict */
export interface SearchResult extends CursorState {
  matches: SearchMatch[];
}

/** @schema @strict */
export interface RevisionListResult extends CursorState {
  revisions: NodeRevisionSummary[];
}

/** @schema @strict */
export interface RevisionShowResult extends CursorState {
  details: RevisionDetails;
}

/** @schema @strict */
export interface ProposalListResult extends CursorState {
  proposals: ProposalSummary[];
}

/** @schema @strict */
export interface ProposalDecisionResult extends CursorState {
  proposalId: Id;
  status: ProposalStatus;
}

/** @schema @strict */
export interface ForkResult extends CursorState {
  forkedSessionId: string;
}

/** @schema @strict */
export interface SessionInput {
  /** @minLength 1 */
  sessionId: string;
}

/** @schema @strict */
export interface PwdInput extends SessionInput {
  cwd?: string;
}

/** @schema @strict */
export interface PathInput extends SessionInput {
  path?: string;
}

/** @schema @strict */
export interface CdInput extends SessionInput {
  /** @minLength 1 */
  path: string;
}

/** @schema @strict */
export interface MkdirInput extends SessionInput {
  /** @minLength 1 */
  name: string;
  work?: WorkPatch;
}

/** @schema @strict */
export interface EditInput extends SessionInput {
  patch: WorkPatch;
}

/** @schema @strict */
export interface MoveInput extends SessionInput {
  /** @minLength 1 */
  source: string;

  /** @minLength 1 */
  destination: string;
}

/** @schema @strict */
export interface CloseInput extends SessionInput {
  /** @minLength 1 */
  summary: string;

  /** @default done */
  status: "done" | "abandoned" | "superseded";
}

/** @schema @strict */
export interface SearchInput extends SessionInput {
  /** @minLength 1 */
  query: string;

  /** @default subtree */
  scope: SearchScope;

  /** Relative or absolute subtree root; does not move the cursor. */
  path?: string;
}

/** @schema @strict */
export interface RevisionShowInput extends PathInput {
  revisionId: Id;
}

/** @schema @strict */
export interface ForkInput extends SessionInput {
  /** @minLength 1 */
  newSessionId: string;
}

/** @schema @strict */
export interface DecideProposalInput extends SessionInput {
  proposalId: Id;
  decision: ProposalDecision;
  replacement?: WorkPatch;
}

/** @schema @strict */
export interface SubmitProposalInput extends SessionInput {
  kind: ProposalKind;
  patch?: WorkPatch;

  /** @minLength 1 */
  sourceSessionId?: string;
}

/** @schema @strict */
export interface HelloInput {
  protocolVersion: 2;

  /** @minLength 1 */
  schemaDigest: string;
}

/** @schema @strict */
export interface HelloOutput {
  protocolVersion: 2;
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
  protocolVersion: 2;
  schemaDigest: string;
  operations: DescribeOperation[];
}

export interface OperationContracts {
  hello: { input: HelloInput; output: HelloOutput; command: false };
  describe: { input: Record<string, never>; output: DescribeOutput; command: false };
  pwd: { input: PwdInput; output: PwdState; command: true };
  ls: { input: PathInput; output: ListResult; command: false };
  cd: { input: CdInput; output: CursorState; command: true };
  mkdir: { input: MkdirInput; output: CursorState; command: true };
  edit: { input: EditInput; output: CursorState; command: true };
  mv: { input: MoveInput; output: CursorState; command: true };
  close: { input: CloseInput; output: CursorState; command: true };
  search: { input: SearchInput; output: SearchResult; command: false };
  "rev-list": { input: PathInput; output: RevisionListResult; command: false };
  "rev-show": { input: RevisionShowInput; output: RevisionShowResult; command: false };
  fork: { input: ForkInput; output: ForkResult; command: true };
  briefing: { input: SessionInput; output: BriefingResult; command: false };
  proposals: { input: SessionInput; output: ProposalListResult; command: false };
  "decide-proposal": {
    input: DecideProposalInput;
    output: ProposalDecisionResult;
    command: true;
  };
  "submit-proposal": {
    input: SubmitProposalInput;
    output: ProposalSummary;
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
  protocolVersion: 2;

  /** @minLength 1 */
  id: string;

  /** @minLength 1 */
  idempotencyKey?: string;

  method: OperationName;
  params: JsonValue;
}

/** @schema @strict */
export interface RpcSuccess {
  protocolVersion: 2;
  id: string;
  ok: true;
  result: JsonValue;
}

/** @schema @strict */
export interface RpcFailure {
  protocolVersion: 2;
  id: string;
  ok: false;
  error: RpcError;
}

/** @schema */
export type RpcResponse = RpcSuccess | RpcFailure;
