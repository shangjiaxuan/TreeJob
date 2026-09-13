import {
  CommandHelpResultSchema,
  IdSchema,
  OperationSchemas,
  ProposalDecisionSchema,
  ProposalKindSchema,
  RevisionSchema,
  SearchScopeSchema,
  StatusSchema,
  WorkPatchSchema,
  type CommandAtom,
  type CommandHelpEntry,
  type CommandHelpResult,
  type CommandInput,
  type JsonValue,
  type OperationName,
} from "./schema.js";

type UseCaseName = Exclude<OperationName, "hello">;

type ParsedOperation = {
  kind: "operation";
  name: UseCaseName;
  input: unknown;
};

type ParsedHelp = {
  kind: "help";
  result: CommandHelpResult;
};

export type ParsedCommand = ParsedOperation | ParsedHelp;

type CommandDefinition = {
  name: string;
  description: string;
  usage: string;
  visibility: "public" | "internal";
  requiresSession: boolean;
  operation: UseCaseName;
  parse: (sessionId: string, arguments_: readonly CommandAtom[]) => unknown;
};

type ParsedArguments = {
  positionals: CommandAtom[];
  options: Map<string, string>;
};

const definitions: readonly CommandDefinition[] = [
  command(
    "pwd",
    "Show current path and work; initialize a missing session.",
    "pwd [cwd]",
    "pwd",
    (sessionId, args) => ({ sessionId, cwd: optionalString(args, 0, "cwd") }),
  ),
  command(
    "ls",
    "List direct children at a current or historical path.",
    "ls [path] [--revision=N] [--reference=N]",
    "ls",
    (sessionId, args) => listInput(sessionId, args),
  ),
  command(
    "cd",
    "Move the cursor to a relative or absolute path.",
    "cd <path>",
    "cd",
    (sessionId, args) => ({ sessionId, path: exactString(args, "path") }),
  ),
  command(
    "mkdir",
    "Create a child node while remaining in its parent.",
    "mkdir <name> [work-json]",
    "mkdir",
    (sessionId, args) => ({
      sessionId,
      name: requiredString(args, 0, "name"),
      work: optionalWorkPatch(args, 1),
    }),
  ),
  command(
    "edit",
    "Patch the current node's work payload.",
    "edit <patch-json>",
    "edit",
    (sessionId, args) => ({ sessionId, patch: requiredWorkPatch(args, 0) }),
  ),
  command(
    "mv",
    "Move or rename a node using filesystem paths.",
    "mv <source> <destination>",
    "mv",
    (sessionId, args) => ({ sessionId, ...twoPaths(args) }),
  ),
  command(
    "close",
    "Close current work and return to its parent where possible.",
    "close <done|abandoned|superseded> <summary>",
    "close",
    (sessionId, args) => ({ sessionId, ...closeInput(args) }),
  ),
  command(
    "search",
    "Search the current subtree by default.",
    "search <query> [path] [--scope=<subtree|session|workspace|global|history>]",
    "search",
    (sessionId, args) => searchInput(sessionId, args),
  ),
  command(
    "rev-list",
    "List snapshot history for the current node or a path.",
    "rev-list [path] [--reference=N]",
    "rev-list",
    (sessionId, args) => revisionListInput(sessionId, args),
  ),
  command(
    "rev-show",
    "Show a path at a selected session snapshot revision.",
    "rev-show <revision> [path] [--reference=N]",
    "rev-show",
    (sessionId, args) => revisionShowInput(sessionId, args),
  ),
  command(
    "fork",
    "Create a frozen child session from the current snapshot.",
    "fork <new-session-id>",
    "fork",
    (sessionId, args) => ({ sessionId, newSessionId: exactString(args, "new-session-id") }),
  ),
  command(
    "briefing",
    "Return compact recovery context for the active ancestry.",
    "briefing",
    "briefing",
    (sessionId, args) => ({ sessionId, ...noArguments(args) }),
  ),
  command(
    "proposals",
    "List pending compact and subagent proposals.",
    "proposals",
    "proposals",
    (sessionId, args) => ({ sessionId, ...noArguments(args) }),
  ),
  command(
    "decide-proposal",
    "Accept, replace, reject, or discard a proposal.",
    "decide-proposal <proposal-id> <accept|replace|reject|discard> [replacement-json]",
    "decide-proposal",
    (sessionId, args) => ({
      sessionId,
      proposalId: id(args[0], "proposal-id"),
      decision: ProposalDecisionSchema.parse(requiredString(args, 1, "decision")),
      replacement: optionalWorkPatch(args, 2),
    }),
  ),
  {
    name: "_submit-proposal",
    description: "Internal lifecycle-hook proposal submission.",
    usage: "_submit-proposal <proposal-json>",
    visibility: "internal",
    requiresSession: true,
    operation: "submit-proposal",
    parse: (sessionId, args) => {
      const proposal = requiredObject(args, 0, "proposal-json");
      requireArgumentCount(args, 1);
      return {
        sessionId,
        kind: ProposalKindSchema.parse(proposal.kind),
        patch: proposal.patch === undefined
          ? undefined
          : WorkPatchSchema.parse(proposal.patch),
        sourceSessionId: proposal.sourceSessionId === undefined
          ? undefined
          : stringValue(proposal.sourceSessionId, "sourceSessionId"),
      };
    },
  },
];

const byName = new Map(definitions.map((definition) => [definition.name, definition]));

export const publicCommandHelp: readonly CommandHelpEntry[] = definitions
  .filter((definition) => definition.visibility === "public")
  .map(helpEntry);

export function parseCommand(input: CommandInput): ParsedCommand {
  const [commandName, ...arguments_] = input.command;

  if (typeof commandName !== "string" || commandName.length === 0) {
    throw new Error("command name must be a non-empty string");
  }

  if (commandName === "help") {
    return parseHelp(arguments_);
  }

  const definition = byName.get(commandName);

  if (
    !definition ||
    definition.visibility === "internal" && definition.name !== "_submit-proposal"
  ) {
    throw new Error("unknown Context Tree command: " + commandName);
  }

  if (definition.requiresSession && !input.sessionId) {
    throw new Error("sessionId is required for command: " + commandName);
  }

  if (!["search", "ls", "rev-list", "rev-show"].includes(definition.name)) {
    rejectLongOptions(arguments_);
  }

  const parsed = definition.parse(input.sessionId ?? "", arguments_);
  return { kind: "operation", name: definition.operation, input: parsed };
}

function command(
  name: string,
  description: string,
  usage: string,
  operation: UseCaseName,
  parse: (sessionId: string, arguments_: readonly CommandAtom[]) => unknown,
): CommandDefinition {
  return { name, description, usage, visibility: "public", requiresSession: true, operation, parse };
}

function parseHelp(arguments_: readonly CommandAtom[]): ParsedHelp {
  if (arguments_.length === 0) {
    return { kind: "help", result: CommandHelpResultSchema.parse({ commands: publicCommandHelp }) };
  }

  requireArgumentCount(arguments_, 1);
  const name = requiredString(arguments_, 0, "command");
  const definition = byName.get(name);

  if (!definition || definition.visibility !== "public") {
    throw new Error("unknown MCP-visible command: " + name);
  }

  return { kind: "help", result: CommandHelpResultSchema.parse({ command: helpEntry(definition) }) };
}

function helpEntry(definition: CommandDefinition): CommandHelpEntry {
  return { name: definition.name, description: definition.description, usage: definition.usage };
}

function searchInput(sessionId: string, arguments_: readonly CommandAtom[]): unknown {
  const parsed = splitOptions(arguments_);
  ensureOptions(parsed.options, ["scope"]);
  requireArgumentCount(parsed.positionals, 1, 2);
  const scope = parsed.options.has("scope")
    ? SearchScopeSchema.parse(parsed.options.get("scope"))
    : "subtree";
  const path = optionalString(parsed.positionals, 1, "path");

  if (scope !== "subtree" && path !== undefined) {
    throw new Error("search path is only valid with the subtree scope");
  }

  return { sessionId, query: requiredString(parsed.positionals, 0, "query"), scope, path };
}

function listInput(sessionId: string, arguments_: readonly CommandAtom[]): unknown {
  const parsed = splitOptions(arguments_);
  ensureOptions(parsed.options, ["revision", "reference"]);
  requireArgumentCount(parsed.positionals, 0, 1);
  return {
    sessionId,
    path: optionalString(parsed.positionals, 0, "path"),
    revision: optionRevision(parsed.options, "revision"),
    reference: optionRevision(parsed.options, "reference"),
  };
}

function revisionListInput(sessionId: string, arguments_: readonly CommandAtom[]): unknown {
  const parsed = splitOptions(arguments_);
  ensureOptions(parsed.options, ["reference"]);
  requireArgumentCount(parsed.positionals, 0, 1);
  return {
    sessionId,
    path: optionalString(parsed.positionals, 0, "path"),
    reference: optionRevision(parsed.options, "reference"),
  };
}

function revisionShowInput(sessionId: string, arguments_: readonly CommandAtom[]): unknown {
  const parsed = splitOptions(arguments_);
  ensureOptions(parsed.options, ["reference"]);
  requireArgumentCount(parsed.positionals, 1, 2);
  return {
    sessionId,
    revision: revision(parsed.positionals[0], "revision"),
    path: optionalString(parsed.positionals, 1, "path"),
    reference: optionRevision(parsed.options, "reference"),
  };
}

function rejectLongOptions(arguments_: readonly CommandAtom[]): void {
  for (const argument of arguments_) {
    if (typeof argument === "string" && argument.startsWith("--")) {
      throw new Error("unknown option: " + argument);
    }
  }
}

function splitOptions(arguments_: readonly CommandAtom[]): ParsedArguments {
  const positionals: CommandAtom[] = [];
  const options = new Map<string, string>();

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (typeof argument !== "string" || !argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const match = /^--([A-Za-z][A-Za-z0-9-]*)(?:=(.*))?$/.exec(argument);

    if (!match) {
      throw new Error("invalid long option: " + argument);
    }

    const name = match[1];
    let value = match[2];

    if (value === undefined) {
      const next = arguments_[index + 1];

      if (typeof next !== "string" || next.startsWith("--")) {
        throw new Error("value is required for --" + name);
      }

      value = next;
      index += 1;
    }

    if (options.has(name)) {
      throw new Error("option was specified twice: --" + name);
    }

    options.set(name, value);
  }

  return { positionals, options };
}

function ensureOptions(options: ReadonlyMap<string, string>, allowed: readonly string[]): void {
  for (const name of options.keys()) {
    if (!allowed.includes(name)) {
      throw new Error("unknown option: --" + name);
    }
  }
}

function noArguments(arguments_: readonly CommandAtom[]): Record<string, never> {
  requireArgumentCount(arguments_, 0);
  return {};
}

function requireArgumentCount(arguments_: readonly CommandAtom[], minimum: number, maximum = minimum): void {
  if (arguments_.length < minimum || arguments_.length > maximum) {
    const expected = minimum === maximum ? String(minimum) : minimum + " to " + maximum;
    throw new Error("expected " + expected + " argument(s), received " + arguments_.length);
  }
}

function requiredString(arguments_: readonly CommandAtom[], index: number, label: string): string {
  const value = arguments_[index];

  if (value === undefined) {
    throw new Error(label + " is required");
  }

  return stringValue(value, label);
}

function exactString(arguments_: readonly CommandAtom[], label: string): string {
  requireArgumentCount(arguments_, 1);
  return requiredString(arguments_, 0, label);
}

function twoPaths(arguments_: readonly CommandAtom[]): { source: string; destination: string } {
  requireArgumentCount(arguments_, 2);
  return {
    source: requiredString(arguments_, 0, "source"),
    destination: requiredString(arguments_, 1, "destination"),
  };
}

function closeInput(arguments_: readonly CommandAtom[]): {
  status: "done" | "abandoned" | "superseded";
  summary: string;
} {
  requireArgumentCount(arguments_, 2);
  return {
    status: terminalStatus(requiredString(arguments_, 0, "status")),
    summary: requiredString(arguments_, 1, "summary"),
  };
}

function optionalString(arguments_: readonly CommandAtom[], index: number, label: string): string | undefined {
  requireArgumentCount(arguments_, 0, index + 1);
  const value = arguments_[index];
  return value === undefined ? undefined : stringValue(value, label);
}

function stringValue(value: JsonValue, label: string): string {
  if (typeof value !== "string") {
    throw new Error(label + " must be a string");
  }

  return value;
}

function id(value: CommandAtom | undefined, label: string): number {
  if (typeof value === "number") {
    return IdSchema.parse(value);
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return IdSchema.parse(Number(value));
  }

  throw new Error(label + " must be an integer");
}

function optionId(options: ReadonlyMap<string, string>, name: string): number | undefined {
  const value = options.get(name);
  return value === undefined ? undefined : id(value, "--" + name);
}

function revision(value: CommandAtom | undefined, label: string): number {
  if (typeof value === "number") return RevisionSchema.parse(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return RevisionSchema.parse(Number(value));
  throw new Error(label + " must be a non-negative integer");
}

function optionRevision(options: ReadonlyMap<string, string>, name: string): number | undefined {
  const value = options.get(name);
  return value === undefined ? undefined : revision(value, "--" + name);
}

function requiredObject(arguments_: readonly CommandAtom[], index: number, label: string): Record<string, JsonValue> {
  const value = arguments_[index];

  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(label + " must be a JSON object");
  }

  return value;
}

function requiredWorkPatch(arguments_: readonly CommandAtom[], index: number) {
  requireArgumentCount(arguments_, index + 1);
  return WorkPatchSchema.parse(requiredObject(arguments_, index, "patch-json"));
}

function optionalWorkPatch(arguments_: readonly CommandAtom[], index: number) {
  requireArgumentCount(arguments_, index, index + 1);
  return arguments_[index] === undefined ? undefined : WorkPatchSchema.parse(requiredObject(arguments_, index, "work-json"));
}

function terminalStatus(value: string): "done" | "abandoned" | "superseded" {
  const status = StatusSchema.parse(value);

  if (status === "open" || status === "blocked") {
    throw new Error("close status must be done, abandoned, or superseded");
  }

  return status;
}
