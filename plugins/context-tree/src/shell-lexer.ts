import type { CommandAtom } from "./schema.js";

/**
 * Translate human shell text into the exact JSON-compatible argv array sent to
 * the daemon. Context Tree path escaping is deliberately not interpreted here.
 */
export function tokenize(line: string): CommandAtom[] {
  const tokens: CommandAtom[] = [];
  let index = 0;

  while (index < line.length) {
    while (index < line.length && /\s/.test(line[index] ?? "")) {
      index += 1;
    }

    if (index >= line.length) {
      break;
    }

    const character = line[index];

    if (character === "\"") {
      const quoted = readQuoted(line, index);
      tokens.push(quoted.value);
      index = quoted.next;
      continue;
    }

    if (character === "{") {
      const json = readJson(line, index, "{", "}");
      tokens.push(json.value);
      index = json.next;
      continue;
    }

    if (character === "[") {
      const json = readJson(line, index, "[", "]");
      tokens.push(json.value);
      index = json.next;
      continue;
    }

    if (character === "'") {
      throw new Error("single quotes are not supported; use double quotes or JSON");
    }

    const start = index;

    while (index < line.length && !/\s/.test(line[index] ?? "")) {
      index += 1;
    }

    tokens.push(line.slice(start, index));
  }

  return tokens;
}

function readQuoted(line: string, start: number): { value: string; next: number } {
  let value = "";
  let index = start + 1;

  while (index < line.length) {
    const character = line[index];

    if (character === "\"") {
      return { value, next: index + 1 };
    }

    if (character === "\\") {
      const next = line[index + 1];

      if (next === "\"" || next === "\\") {
        value += next;
        index += 2;
        continue;
      }
    }

    value += character;
    index += 1;
  }

  throw new Error("command has an unclosed double quote");
}

function readJson(
  line: string,
  start: number,
  opening: "{" | "[",
  closing: "}" | "]",
): { value: CommandAtom; next: number } {
  let index = start;
  let depth = 0;
  let inString = false;
  let escaped = false;

  while (index < line.length) {
    const character = line[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }

      index += 1;
      continue;
    }

    if (character === "\"") {
      inString = true;
    } else if (character === opening) {
      depth += 1;
    } else if (character === closing) {
      depth -= 1;

      if (depth === 0) {
        const source = line.slice(start, index + 1);
        const next = index + 1;

        if (next < line.length && !/\s/.test(line[next] ?? "")) {
          throw new Error("JSON argument must end before the next command argument");
        }

        try {
          return { value: JSON.parse(source) as CommandAtom, next };
        } catch {
          throw new Error("invalid JSON command argument");
        }
      }
    }

    index += 1;
  }

  throw new Error("command has an unclosed JSON argument");
}
