import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  Context,
  Cursor,
  DirectoryEntry,
  DirectoryInode,
  InodeId,
  JsonValue,
  OperationContracts,
  OperationName,
  PayloadFields,
  PayloadInode,
  PayloadPatch,
  Proposal,
  ProposalStatus,
  RecordStatus,
  Reference,
  RpcFailure,
  RpcRequest,
  RpcResponse,
  RpcSuccess,
  Snapshot,
  Timestamp,
  SessionState,
  Workspace,
} from "./contracts.js";
import { contractMetadata } from "./generated/contracts-metadata.js";
import { ContractRuntime } from "./schema-runtime.js";

export const PROTOCOL_VERSION = 1 as const;

const runtime = new ContractRuntime(contractMetadata);

/**
 * The sole static-to-runtime bridge. Every schema comes from compiler-generated
 * metadata, and Zod validates before a value becomes the declared type.
 */
function typedSchema<T>(name: string): z.ZodType<T> {
  return typedRuntimeSchema(runtime.schema(name));
}

function typedRuntimeSchema<T>(schema: z.ZodType): z.ZodType<T> {
  return schema as z.ZodType<T>;
}

export const IdSchema = typedSchema<InodeId>("InodeId");
export const TimestampSchema = typedSchema<Timestamp>("Timestamp");
export const StatusSchema = typedSchema<RecordStatus>("RecordStatus");
export const JsonSchema = typedSchema<JsonValue>("JsonValue");
export const ReferenceSchema = typedSchema<Reference>("Reference");
export const PayloadFieldsSchema = typedSchema<PayloadFields>("PayloadFields");
export const PayloadPatchSchema = typedSchema<PayloadPatch>("PayloadPatch");
export const PayloadInodeSchema = typedSchema<PayloadInode>("PayloadInode");
export const DirectoryEntrySchema = typedSchema<DirectoryEntry>("DirectoryEntry");
export const DirectoryInodeSchema = typedSchema<DirectoryInode>("DirectoryInode");
export const SnapshotSchema = typedSchema<Snapshot>("Snapshot");
export const CursorSchema = typedSchema<Cursor>("Cursor");
export const ProposalSchema = typedSchema<Proposal>("Proposal");
export const ContextSchema = typedSchema<Context>("Context");
export const SessionStateSchema = typedSchema<SessionState>("SessionState");
export const WorkspaceSchema = typedSchema<Workspace>("Workspace");

export type {
  Context,
  Cursor,
  DirectoryEntry,
  DirectoryInode,
  InodeId,
  JsonValue,
  OperationName,
  PayloadFields,
  PayloadInode,
  PayloadPatch,
  Proposal,
  ProposalStatus,
  RecordStatus,
  Reference,
  RpcFailure,
  RpcRequest,
  RpcResponse,
  RpcSuccess,
  Snapshot,
  Timestamp,
  SessionState,
  Workspace,
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

  return {
    input: typedRuntimeSchema(runtime.compile(metadata.input)),
    output: typedRuntimeSchema(runtime.compile(metadata.output)),
    command: metadata.command.kind === "literal" &&
      typeof metadata.command.value === "boolean"
      ? metadata.command.value
      : invalidCommandMetadata(name),
  };
}

function invalidCommandMetadata(name: string): never {
  throw new Error("operation command metadata must be boolean: " + name);
}

export const OperationSchemas = {
  hello: operation("hello"),
  describe: operation("describe"),
  registerSession: operation("registerSession"),
  getContext: operation("getContext"),
  searchContext: operation("searchContext"),
  searchHistory: operation("searchHistory"),
  pushChild: operation("pushChild"),
  addSibling: operation("addSibling"),
  enter: operation("enter"),
  back: operation("back"),
  updateRecord: operation("updateRecord"),
  closeRecord: operation("closeRecord"),
  forkSession: operation("forkSession"),
  createProposal: operation("createProposal"),
  listProposals: operation("listProposals"),
  decideProposal: operation("decideProposal"),
} satisfies {
  [N in OperationName]: OperationSchema<N>;
};

export const OperationNameSchema = typedSchema<OperationName>("OperationName");
export const RpcRequestSchema = typedSchema<RpcRequest>("RpcRequest");
export const RpcSuccessSchema = typedSchema<RpcSuccess>("RpcSuccess");
export const RpcFailureSchema = typedSchema<RpcFailure>("RpcFailure");
export const RpcResponseSchema = typedSchema<RpcResponse>("RpcResponse");

export const schemaDigest = createHash("sha256").update(
  Object.entries(OperationSchemas).map(([name, operation]) => {
    return name + ":" +
      JSON.stringify(z.toJSONSchema(operation.input)) + ":" +
      JSON.stringify(z.toJSONSchema(operation.output));
  }).join("\n"),
).digest("hex");
