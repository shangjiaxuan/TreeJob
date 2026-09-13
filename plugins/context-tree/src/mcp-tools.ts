import { z } from "zod";
import { publicCommandHelp } from "./commands.js";
import { CommandInputSchema } from "./schema.js";

export const mcpTools = [{
  name: "command",
  description: [
    "Run one Context Tree filesystem command.",
    "Pass sessionId and a structured command array, for example",
    "{ sessionId: 'session-123', command: ['mkdir', 'detour', { returnCondition: 'Report findings' }] }.",
    "Use ['help'] or ['help', '<command>'] for the daemon-owned public command reference.",
    "Visible commands:",
    publicCommandHelp.map((entry) => entry.name).join(", ") + ".",
  ].join(" "),
  inputSchema: z.toJSONSchema(CommandInputSchema),
}] as const;

export { publicCommandHelp };
