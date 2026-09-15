import { z } from "zod";
import {
  BriefingResultSchema,
  CdResultSchema,
  CloseResultSchema,
  EditResultSchema,
  ForkResultSchema,
  ListResultSchema,
  MkdirResultSchema,
  MoveResultSchema,
  ProposalDecisionResultSchema,
  ProposalDecisionSchema,
  ProposalKindSchema,
  ProposalListResultSchema,
  ProposalSummarySchema,
  ProposalIdSchema,
  PwdStateSchema,
  QueryLinkResultSchema,
  RevisionListResultSchema,
  RevisionSchema,
  RevisionShowResultSchema,
  SearchResultSchema,
  SearchScopeSchema,
  WorkPatchSchema,
} from "../../../protocol/schema.js";

const SessionInputSchema = z.object({
  sessionId: z.string().min(1),
}).strict();

const PathInputSchema = SessionInputSchema.extend({
  path: z.string().optional(),
}).strict();

const TerminalStatusSchema = z.enum(["done", "abandoned", "superseded"]);

export const OperationSchemas = {
  pwd: {
    input: SessionInputSchema.extend({ cwd: z.string().optional() }).strict(),
    output: PwdStateSchema,
  },
  ls: {
    input: PathInputSchema.extend({
      revision: RevisionSchema.optional(),
      reference: RevisionSchema.optional(),
    }).strict(),
    output: ListResultSchema,
  },
  cd: {
    input: SessionInputSchema.extend({ path: z.string().min(1) }).strict(),
    output: CdResultSchema,
  },
  mkdir: {
    input: SessionInputSchema.extend({
      name: z.string().min(1),
      work: WorkPatchSchema.optional(),
    }).strict(),
    output: MkdirResultSchema,
  },
  edit: {
    input: SessionInputSchema.extend({ patch: WorkPatchSchema }).strict(),
    output: EditResultSchema,
  },
  mv: {
    input: SessionInputSchema.extend({
      source: z.string().min(1),
      destination: z.string().min(1),
    }).strict(),
    output: MoveResultSchema,
  },
  close: {
    input: SessionInputSchema.extend({
      status: TerminalStatusSchema,
      summary: z.string().min(1),
    }).strict(),
    output: CloseResultSchema,
  },
  search: {
    input: SessionInputSchema.extend({
      query: z.string().min(1),
      scope: SearchScopeSchema,
      path: z.string().optional(),
    }).strict(),
    output: SearchResultSchema,
  },
  "rev-list": {
    input: PathInputSchema.extend({ reference: RevisionSchema.optional(), verbose: z.boolean() }).strict(),
    output: RevisionListResultSchema,
  },
  "query-link": {
    input: PathInputSchema.extend({
      direction: z.enum(["parent", "child"]),
      revision: RevisionSchema.optional(),
      reference: RevisionSchema.optional(),
    }).strict(),
    output: QueryLinkResultSchema,
  },
  "rev-show": {
    input: PathInputSchema.extend({
      revision: RevisionSchema.optional(),
      reference: RevisionSchema.optional(),
    }).strict(),
    output: RevisionShowResultSchema,
  },
  fork: {
    input: SessionInputSchema.extend({ newSessionId: z.string().min(1) }).strict(),
    output: ForkResultSchema,
  },
  briefing: {
    input: SessionInputSchema,
    output: BriefingResultSchema,
  },
  proposals: {
    input: SessionInputSchema,
    output: ProposalListResultSchema,
  },
  "decide-proposal": {
    input: SessionInputSchema.extend({
      proposalId: ProposalIdSchema,
      decision: ProposalDecisionSchema,
      replacement: WorkPatchSchema.optional(),
    }).strict(),
    output: ProposalDecisionResultSchema,
  },
  "submit-proposal": {
    input: SessionInputSchema.extend({
      kind: ProposalKindSchema,
      patch: WorkPatchSchema.optional(),
      sourceSessionId: z.string().min(1).optional(),
    }).strict(),
    output: ProposalSummarySchema,
  },
} as const;

export type OperationName = keyof typeof OperationSchemas;
