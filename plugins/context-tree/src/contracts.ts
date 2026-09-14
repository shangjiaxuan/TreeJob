/** @schema @int @positive */
export type Id = number;

/** @schema @int @nonnegative */
export type Revision = number;

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
export type CommandAtom = JsonValue;

/** @schema */
export type RecordStatus = "open" | "blocked" | "done" | "abandoned" | "superseded";

/** @schema */
export type ProposalStatus = "pending" | "applied" | "rejected" | "discarded";

/** @schema */
export type ProposalKind = "compact" | "subagent_result" | "manual";

/** @schema */
export type ProposalDecision = "accept" | "replace" | "reject" | "discard";

/** @schema */
export type SearchScope = "subtree" | "session" | "workspace" | "global" | "history";

/** @schema */
export type RevisionChange = "work" | "children" | "renamed" | "moved";

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
export interface CreatedEntry extends EntrySummary {
  path: string;
}

/** @schema @strict */
export interface UpdatedWork {
  path: string;
  fields: string[];
}

/** @schema @strict */
export interface MovedNode {
  from: string;
  to: string;
}

/** @schema @strict */
export interface ClosedNode {
  path: string;
  status: "done" | "abandoned" | "superseded";
  summary: string;
}

/** @schema @strict */
export interface RevisionSummary {
  revision: Revision;
  createdAt: Timestamp;
  changes: RevisionChange[];
}

/** @schema @strict */
export interface SearchMatch {
  path: string;
  name: string;
  field: string;
  snippet: string;
  status: RecordStatus;
  revision?: Revision;
}

/** @schema @strict */
export interface RevisionDetails {
  revision: RevisionSummary;
  view_path: string;
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
  targetPath: string;
  baseWork: CurrentWork;
  patch: WorkPatch | null;
  afterPreview: CurrentWork | null;
}

/** @schema @strict */
export interface ClosedChildOutcome {
  path: string;
  title: string;
  status: "done" | "abandoned" | "superseded";
  summary: string;
}

/** @schema @strict */
export interface BriefingEntry {
  path: string;
  work: CurrentWork;
  closedChildOutcomes: ClosedChildOutcome[];
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
  view_path?: string;
  entries: EntrySummary[];
}

/** @schema @strict */
export interface SearchResult extends CursorState {
  matches: SearchMatch[];
}

/** @schema @strict */
export interface RevisionListResult extends CursorState {
  head_revision: Revision;
  revisions: RevisionSummary[];
}

/** @schema @strict */
export interface RevisionShowResult extends CursorState {
  details: RevisionDetails;
}

/** @schema @strict */
export interface CdResult extends CursorState {
  movedTo: string;
}

/** @schema @strict */
export interface MkdirResult extends CursorState {
  created: CreatedEntry;
}

/** @schema @strict */
export interface EditResult extends CursorState {
  updated: UpdatedWork;
}

/** @schema @strict */
export interface MoveResult extends CursorState {
  moved: MovedNode;
}

/** @schema @strict */
export interface CloseResult extends CursorState {
  closed: ClosedNode;
}

/** @schema @strict */
export interface ProposalListResult extends CursorState {
  proposals: ProposalSummary[];
}

/** @schema @strict */
export interface ProposalDecisionResult extends CursorState {
  proposal: ProposalSummary;
  status: ProposalStatus;
  before: CurrentWork;
  after: CurrentWork | null;
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
export interface ListInput extends PathInput {
  revision?: Revision;
  reference?: Revision;
}

/** @schema @strict */
export interface RevisionListInput extends PathInput {
  reference?: Revision;
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
  path?: string;
}

/** @schema @strict */
export interface RevisionShowInput extends SessionInput {
  revision: Revision;
  path?: string;
  reference?: Revision;
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
export interface CommandInput {
  /** Required for every command except help. */
  sessionId?: string;
  /** @minItems 1 */
  command: CommandAtom[];
}

/** @schema @strict */
export interface CommandHelpEntry {
  name: string;
  description: string;
  usage: string;
}

/** @schema @strict */
export interface CommandHelpResult {
  commands?: CommandHelpEntry[];
  command?: CommandHelpEntry;
}

/** @schema @strict */
export interface HelloInput {
  protocolVersion: 5;
  /** @minLength 1 */
  schemaDigest: string;
}

/** @schema @strict */
export interface HelloOutput {
  protocolVersion: 5;
  schemaDigest: string;
  daemon: string;
}

/** @schema @strict */
export interface OperationContracts {
  hello: { input: HelloInput; output: HelloOutput; command: false };
  pwd: { input: PwdInput; output: PwdState; command: true };
  ls: { input: ListInput; output: ListResult; command: false };
  cd: { input: CdInput; output: CdResult; command: true };
  mkdir: { input: MkdirInput; output: MkdirResult; command: true };
  edit: { input: EditInput; output: EditResult; command: true };
  mv: { input: MoveInput; output: MoveResult; command: true };
  close: { input: CloseInput; output: CloseResult; command: true };
  search: { input: SearchInput; output: SearchResult; command: false };
  "rev-list": { input: RevisionListInput; output: RevisionListResult; command: false };
  "rev-show": { input: RevisionShowInput; output: RevisionShowResult; command: false };
  fork: { input: ForkInput; output: ForkResult; command: true };
  briefing: { input: SessionInput; output: BriefingResult; command: false };
  proposals: { input: SessionInput; output: ProposalListResult; command: false };
  "decide-proposal": { input: DecideProposalInput; output: ProposalDecisionResult; command: true };
  "submit-proposal": { input: SubmitProposalInput; output: ProposalSummary; command: true };
}

/** @schema */
export type OperationName = keyof OperationContracts;

/** @schema */
export type RpcMethod = "hello" | "command";

/** @schema */
export type RpcErrorCode = "validation" | "unsupported_protocol" | "not_found" | "conflict" | "invariant" | "internal";

/** @schema @strict */
export interface RpcError {
  code: RpcErrorCode;
  message: string;
  details?: JsonValue;
}

/** @schema @strict */
export interface RpcRequest {
  protocolVersion: 5;
  /** @minLength 1 */
  id: string;
  /** @minLength 1 */
  idempotencyKey?: string;
  method: RpcMethod;
  params: JsonValue;
}

/** @schema @strict */
export interface RpcSuccess {
  protocolVersion: 5;
  id: string;
  ok: true;
  result: JsonValue;
}

/** @schema @strict */
export interface RpcFailure {
  protocolVersion: 5;
  id: string;
  ok: false;
  error: RpcError;
}

/** @schema */
export type RpcResponse = RpcSuccess | RpcFailure;
