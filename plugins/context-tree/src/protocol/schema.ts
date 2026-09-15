import { z } from "zod";
import type {
  BriefingResult,
  CommandAtom,
  CommandHelpEntry,
  CommandHelpResult,
  CommandInput,
  CdResult,
  CloseResult,
  ClosedChildOutcome,
  ClosedNode,
  CursorState,
  CurrentDirectory,
  CurrentWork,
  CreatedEntry,
  EditResult,
  EntrySummary,
  ForkResult,
  JsonValue,
  ListResult,
  MkdirResult,
  MoveResult,
  MailboxCandidate,
  MailboxResult,
  MailboxDecisionResult,
  IdentityResult,
  AccessResult,
  MovedNode,
  RevisionSummary,
  ProposalDecision,
  ProposalKind,
  ProposalStatus,
  ProposalDecisionResult,
  ProposalListResult,
  ProposalSummary,
  PwdState,
  QueryLinkResult,
  RecordStatus,
  Reference,
  Revision,
  RevisionDetails,
  RevisionListResult,
  RevisionShowResult,
  SearchMatch,
  SearchScope,
  SearchResult,
  ProposalId,
  Timestamp,
  WorkFields,
  WorkPatch,
  UpdatedWork,
} from "./contracts.js";
import { contractMetadata } from "./generated/contracts-metadata.js";
import { ContractRuntime } from "./schema-runtime.js";

const runtime = new ContractRuntime(contractMetadata);

function typedSchema<T>(name: string): z.ZodType<T> {
  return runtime.schema(name) as z.ZodType<T>;
}

export const ProposalIdSchema = typedSchema<ProposalId>("ProposalId");
export const RevisionSchema = typedSchema<Revision>("Revision");
export const TimestampSchema = typedSchema<Timestamp>("Timestamp");
export const JsonSchema = typedSchema<JsonValue>("JsonValue");
export const CommandInputSchema = typedSchema<CommandInput>("CommandInput");
export const CommandHelpEntrySchema = typedSchema<CommandHelpEntry>("CommandHelpEntry");
export const CommandHelpResultSchema = typedSchema<CommandHelpResult>("CommandHelpResult");
export const StatusSchema = typedSchema<RecordStatus>("RecordStatus");
export const ReferenceSchema = typedSchema<Reference>("Reference");
export const WorkFieldsSchema = typedSchema<WorkFields>("WorkFields");
export const WorkPatchSchema = typedSchema<WorkPatch>("WorkPatch");
export const PwdStateSchema = typedSchema<PwdState>("PwdState");
export const QueryLinkResultSchema = typedSchema<QueryLinkResult>("QueryLinkResult");
export const CursorStateSchema = typedSchema<CursorState>("CursorState");
export const CdResultSchema = typedSchema<CdResult>("CdResult");
export const MkdirResultSchema = typedSchema<MkdirResult>("MkdirResult");
export const EditResultSchema = typedSchema<EditResult>("EditResult");
export const MoveResultSchema = typedSchema<MoveResult>("MoveResult");
export const MailboxResultSchema = typedSchema<MailboxResult>("MailboxResult");
export const MailboxDecisionResultSchema = typedSchema<MailboxDecisionResult>("MailboxDecisionResult");
export const IdentityResultSchema = typedSchema<IdentityResult>("IdentityResult");
export const AccessResultSchema = typedSchema<AccessResult>("AccessResult");
export const CloseResultSchema = typedSchema<CloseResult>("CloseResult");
export const ForkResultSchema = typedSchema<ForkResult>("ForkResult");
export const BriefingResultSchema = typedSchema<BriefingResult>("BriefingResult");
export const ListResultSchema = typedSchema<ListResult>("ListResult");
export const SearchResultSchema = typedSchema<SearchResult>("SearchResult");
export const RevisionListResultSchema = typedSchema<RevisionListResult>("RevisionListResult");
export const RevisionShowResultSchema = typedSchema<RevisionShowResult>("RevisionShowResult");
export const ProposalSummarySchema = typedSchema<ProposalSummary>("ProposalSummary");
export const ProposalListResultSchema = typedSchema<ProposalListResult>("ProposalListResult");
export const ProposalDecisionResultSchema = typedSchema<ProposalDecisionResult>("ProposalDecisionResult");
export const ProposalKindSchema = typedSchema<ProposalKind>("ProposalKind");
export const ProposalStatusSchema = typedSchema<ProposalStatus>("ProposalStatus");
export const ProposalDecisionSchema = typedSchema<ProposalDecision>("ProposalDecision");
export const SearchScopeSchema = typedSchema<SearchScope>("SearchScope");

export type {
  BriefingResult,
  CommandAtom,
  CommandHelpEntry,
  CommandHelpResult,
  CommandInput,
  CdResult,
  CloseResult,
  ClosedChildOutcome,
  ClosedNode,
  CursorState,
  CurrentDirectory,
  CurrentWork,
  CreatedEntry,
  EditResult,
  EntrySummary,
  ForkResult,
  JsonValue,
  ListResult,
  MkdirResult,
  MoveResult,
  MailboxCandidate,
  MailboxResult,
  MailboxDecisionResult,
  IdentityResult,
  AccessResult,
  MovedNode,
  RevisionSummary,
  ProposalDecision,
  ProposalKind,
  ProposalStatus,
  ProposalDecisionResult,
  ProposalListResult,
  ProposalSummary,
  PwdState,
  QueryLinkResult,
  RecordStatus,
  Reference,
  Revision,
  RevisionDetails,
  RevisionListResult,
  RevisionShowResult,
  SearchMatch,
  SearchScope,
  SearchResult,
  ProposalId,
  Timestamp,
  WorkFields,
  WorkPatch,
  UpdatedWork,
};
