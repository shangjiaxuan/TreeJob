import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mcpTools } from "./mcp-tools.js";
import { callRaw } from "./rpc.js";
import { OperationNameSchema, type OperationName } from "./schema.js";

type ShellOptions = {
  dataDir: string;
};

const options = parseOptions(process.argv.slice(2));
process.env.CONTEXT_TREE_DATA_DIR = options.dataDir;
const defaultSessionId = "shell-" + randomUUID();

const readline = createInterface({
  input: stdin,
  output: stdout,
  terminal: Boolean(stdin.isTTY && stdout.isTTY),
});

stdout.write("Context Tree protocol shell\n");
stdout.write("Database: " + options.dataDir + "\n");
stdout.write("Default session: " + defaultSessionId + "\n");
stdout.write("Enter an operation followed by --field value parameters.\n");
stdout.write("Use JSON directly for arrays and objects. Type help for examples.\n\n");

for await (const line of readline) {
  try {
    const shouldContinue = await execute(line);

    if (!shouldContinue) {
      break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stdout.write("Error: " + message + "\n");
  }
}

readline.close();

async function execute(line: string): Promise<boolean> {
  const tokens = tokenize(line);

  if (tokens.length === 0) {
    return true;
  }

  const [command, ...parameterTokens] = tokens;

  if (command === "help") {
    showHelp(parameterTokens);
    return true;
  }

  if (command === "quit" || command === "exit") {
    return false;
  }

  const method = OperationNameSchema.parse(command);
  const params = parseParameters(parameterTokens);
  applySessionDefaults(method, params);
  const result = await callRaw(method, params);

  renderResult(result);
  return true;
}

function applySessionDefaults(
  method: OperationName,
  params: Record<string, unknown>,
): void {
  if (method === "hello" || method === "describe") {
    return;
  }

  const sessionId = typeof params.sessionId === "string"
    ? params.sessionId
    : defaultSessionId;
  params.sessionId = sessionId;

}

function parseParameters(tokens: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  for (let index = 0; index < tokens.length; index += 2) {
    const option = tokens[index];
    const value = tokens[index + 1];

    if (!option?.startsWith("--")) {
      throw new Error("expected a --field parameter, received: " + option);
    }

    if (option.length === 2) {
      throw new Error("parameter name is required after --");
    }

    if (value === undefined || value.startsWith("--")) {
      throw new Error("value is required for " + option);
    }

    const field = option.slice(2);

    if (Object.hasOwn(params, field)) {
      throw new Error("parameter was specified twice: " + field);
    }

    params[field] = parseJsonValue(value);
  }

  return params;
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (const character of line.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\" && quote === "\"") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }

      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }

      continue;
    }

    current += character;
  }

  if (escaped) {
    throw new Error("command ends with an escape character");
  }

  if (quote) {
    throw new Error("command has an unclosed quote");
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function renderResult(result: unknown): void {
  stdout.write("\nRESULT\n");
  stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function showHelp(arguments_: string[]): void {
  if (arguments_.length > 1) {
    throw new Error("help accepts at most one command name");
  }

  const requested = arguments_[0];

  if (requested) {
    const tool = mcpTools.find((candidate) => candidate.name === requested);

    if (!tool) {
      throw new Error("unknown MCP-visible command: " + requested);
    }

    stdout.write(tool.name + ": " + tool.description + "\n");
    stdout.write(JSON.stringify(tool.inputSchema, null, 2) + "\n");
    return;
  }

  stdout.write([
    "Every non-local command is one Context Tree operation sent unchanged",
    "to the daemon. Parameter names are camelCase protocol field names.",
    "Primitive strings may be unquoted when they contain no spaces. Quote",
    "spaces. JSON arrays and objects are parsed as JSON values.",
    "The shell supplies one generated sessionId when omitted. The daemon",
    "initializes an unbound pwd at its workspace when cwd is omitted.",
    "",
    "MCP-visible tools and their generated input schemas:",
  ].join("\n") + "\n\n");

  for (const tool of mcpTools) {
    stdout.write(tool.name + ": " + tool.description + "\n");
    stdout.write(JSON.stringify(tool.inputSchema, null, 2) + "\n\n");
  }

  stdout.write("Local shell utilities: help [command], quit, exit\n");
}

function parseOptions(args: string[]): ShellOptions {
  const values = new Map<string, string>();
  let ephemeral = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--ephemeral") {
      ephemeral = true;
      continue;
    }

    if (argument === "--help") {
      printUsageAndExit();
    }

    if (argument?.startsWith("--")) {
      const value = args[index + 1];

      if (!value || value.startsWith("--")) {
        throw new Error("missing value for " + argument);
      }

      values.set(argument, value);
      index += 1;
      continue;
    }

    throw new Error("unknown argument: " + argument);
  }

  const requestedDataDir = values.get("--data-dir");

  if (requestedDataDir && ephemeral) {
    throw new Error("use either --data-dir or --ephemeral");
  }

  return {
    dataDir: requestedDataDir ?? mkdtempSync(
      join(tmpdir(), "context-tree-shell-"),
    ),
  };
}

function printUsageAndExit(): never {
  stdout.write(
    "Usage: context-tree-shell " +
      "[--data-dir <directory> | --ephemeral]\n",
  );
  process.exit(0);
}
