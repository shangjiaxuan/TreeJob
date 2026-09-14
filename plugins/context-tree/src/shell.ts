import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { callCommand } from "./rpc.js";
import { tokenize } from "./shell-lexer.js";

type ShellOptions = {
  dataDir: string;
  sessionId: string | null;
  cleanupDataDir: boolean;
};

const options = parseOptions(process.argv.slice(2));
process.env.CONTEXT_TREE_DATA_DIR = options.dataDir;
if (options.cleanupDataDir) process.env.CONTEXT_TREE_EPHEMERAL = "1";
const defaultSessionId = options.sessionId ?? "shell-" + randomUUID();

const readline = createInterface({
  input: stdin,
  output: stdout,
  terminal: Boolean(stdin.isTTY && stdout.isTTY),
});

stdout.write("Context Tree command shell\n");
stdout.write("Database: " + options.dataDir + "\n");
stdout.write("Default session: " + defaultSessionId + "\n");
stdout.write("Enter filesystem commands. Type help for the daemon command reference.\n\n");

try {
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
} finally {
  readline.close();
  if (options.cleanupDataDir) await cleanupTemporaryDataDir(options.dataDir);
}

async function execute(line: string): Promise<boolean> {
  const command = tokenize(line);

  if (command.length === 0) {
    return true;
  }

  if (command[0] === "quit" || command[0] === "exit") {
    return false;
  }

  const isHelp = command[0] === "help";
  const result = await callCommand({
    ...(isHelp ? {} : { sessionId: defaultSessionId }),
    command,
  });

  renderResult(result);
  return true;
}

function renderResult(result: unknown): void {
  stdout.write("\nRESULT\n");
  stdout.write(JSON.stringify(result, null, 2) + "\n");
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
  const requestedSessionId = values.get("--session-id");

  for (const name of values.keys()) {
    if (name !== "--data-dir" && name !== "--session-id") {
      throw new Error("unknown argument: " + name);
    }
  }

  if (requestedDataDir && ephemeral) {
    throw new Error("use either --data-dir or --ephemeral");
  }

  return {
    dataDir: requestedDataDir ?? mkdtempSync(
      join(tmpdir(), "context-tree-shell-"),
    ),
    sessionId: requestedSessionId ?? null,
    cleanupDataDir: !requestedDataDir,
  };
}

async function cleanupTemporaryDataDir(directory: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stdout.write("Context Tree could not clean temporary data at " + directory + ": " + message + "\n");
  }
}

function printUsageAndExit(): never {
  stdout.write(
    "Usage: context-tree-shell " +
      "[--data-dir <directory> | --ephemeral] [--session-id <id>]\n",
  );
  process.exit(0);
}
