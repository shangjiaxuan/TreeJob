/** @schema @int @positive */
export type ProposalId = number;

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
export interface SessionViewIdentity {
  sessionId: string;
  revision: Revision;
}

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
  created_view?: SessionViewIdentity;
}

/** @schema @strict */
export interface LinkRevision {
  created_view: SessionViewIdentity;
  name: string;
  createdAt: Timestamp;
}

/** @schema @strict */
export interface LinkHistory {
  name: string;
  revisions: LinkRevision[];
}

/** @schema @strict */
export interface QueryLinkResult extends CursorState {
  view: SessionViewIdentity;
  node_path: string;
  direction: "parent" | "child";
  links: LinkHistory[];
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
  proposalId: ProposalId;
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
