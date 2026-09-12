import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  BriefingResult,
  CloseInput,
  CursorState,
  CurrentDirectory,
  CurrentWork,
  DecideProposalInput,
  DescribeOutput,
  EditInput,
  EntrySummary,
  ForkInput,
  ForkResult,
  HelloInput,
  HelloOutput,
  Id,
  JsonValue,
  ListResult,
  MkdirInput,
  MoveInput,
  NodeRevisionSummary,
  OperationContracts,
  OperationName,
  ProposalDecision,
  ProposalKind,
  ProposalStatus,
  PathInput,
  ProposalDecisionResult,
  ProposalListResult,
  ProposalSummary,
  PwdInput,
  PwdState,
  RecordStatus,
  Reference,
  RevisionDetails,
  RevisionListResult,
  RevisionShowInput,
  RevisionShowResult,
  RpcFailure,
  RpcRequest,
  RpcResponse,
  RpcSuccess,
  SearchInput,
  SearchResult,
  SessionInput,
  SubmitProposalInput,
  Timestamp,
  WorkFields,
  WorkPatch,
} from "./contracts.js";
import { contractMetadata } from "./generated/contracts-metadata.js";
import { ContractRuntime } from "./schema-runtime.js";

export const PROTOCOL_VERSION = 2 as const;

const runtime = new ContractRuntime(contractMetadata);

function typedSchema<T>(name: string): z.ZodType<T> {
  return runtime.schema(name) as z.ZodType<T>;
}

export const IdSchema = typedSchema<Id>("Id");
export const TimestampSchema = typedSchema<Timestamp>("Timestamp");
export const JsonSchema = typedSchema<JsonValue>("JsonValue");
export const StatusSchema = typedSchema<RecordStatus>("RecordStatus");
export const ReferenceSchema = typedSchema<Reference>("Reference");
export const WorkFieldsSchema = typedSchema<WorkFields>("WorkFields");
export const WorkPatchSchema = typedSchema<WorkPatch>("WorkPatch");
export const PwdStateSchema = typedSchema<PwdState>("PwdState");
export const CursorStateSchema = typedSchema<CursorState>("CursorState");
export const ProposalSummarySchema = typedSchema<ProposalSummary>("ProposalSummary");
export const ProposalKindSchema = typedSchema<ProposalKind>("ProposalKind");
export const ProposalStatusSchema = typedSchema<ProposalStatus>("ProposalStatus");

export type {
  BriefingResult,
  CloseInput,
  CursorState,
  CurrentDirectory,
  CurrentWork,
  DecideProposalInput,
  DescribeOutput,
  EditInput,
  EntrySummary,
  ForkInput,
  ForkResult,
  HelloInput,
  HelloOutput,
  Id,
  JsonValue,
  ListResult,
  MkdirInput,
  MoveInput,
  NodeRevisionSummary,
  OperationName,
  ProposalDecision,
  ProposalKind,
  ProposalStatus,
  PathInput,
  ProposalDecisionResult,
  ProposalListResult,
  ProposalSummary,
  PwdInput,
  PwdState,
  RecordStatus,
  Reference,
  RevisionDetails,
  RevisionListResult,
  RevisionShowInput,
  RevisionShowResult,
  RpcFailure,
  RpcRequest,
  RpcResponse,
  RpcSuccess,
  SearchInput,
  SearchResult,
  SessionInput,
  SubmitProposalInput,
  Timestamp,
  WorkFields,
  WorkPatch,
};

export type OperationInput<N extends OperationName> =
  OperationContracts[N]["input"];
export type OperationOutput<N extends OperationName> =
  OperationContracts[N]["output"];

type OperationSchema<N extends OperationName> = {
  input: z.ZodType<OperationInput<N>>;
  output: z.ZodType<OperationOutput<N>>;
  command: boolean;
};

function operation<N extends OperationName>(name: N): OperationSchema<N> {
  const metadata = runtime.operation(name);
  const command = metadata.command;

  if (command.kind !== "literal" || typeof command.value !== "boolean") {
    throw new Error("operation command metadata must be boolean: " + name);
  }

  return {
    input: runtime.compile(metadata.input) as z.ZodType<OperationInput<N>>,
    output: runtime.compile(metadata.output) as z.ZodType<OperationOutput<N>>,
    command: command.value,
  };
}

export const OperationSchemas = {
  hello: operation("hello"),
  describe: operation("describe"),
  pwd: operation("pwd"),
  ls: operation("ls"),
  cd: operation("cd"),
  mkdir: operation("mkdir"),
  edit: operation("edit"),
  mv: operation("mv"),
  close: operation("close"),
  search: operation("search"),
  "rev-list": operation("rev-list"),
  "rev-show": operation("rev-show"),
  fork: operation("fork"),
  briefing: operation("briefing"),
  proposals: operation("proposals"),
  "decide-proposal": operation("decide-proposal"),
  "submit-proposal": operation("submit-proposal"),
} satisfies { [N in OperationName]: OperationSchema<N> };

export const OperationNameSchema = typedSchema<OperationName>("OperationName");
export const RpcRequestSchema = typedSchema<RpcRequest>("RpcRequest");
export const RpcSuccessSchema = typedSchema<RpcSuccess>("RpcSuccess");
export const RpcFailureSchema = typedSchema<RpcFailure>("RpcFailure");
export const RpcResponseSchema = typedSchema<RpcResponse>("RpcResponse");

export const schemaDigest = createHash("sha256").update(
  Object.entries(OperationSchemas).map(([name, operation]) =>
    name + ":" + JSON.stringify(z.toJSONSchema(operation.input)) + ":" +
      JSON.stringify(z.toJSONSchema(operation.output))
  ).join("\n"),
).digest("hex");
