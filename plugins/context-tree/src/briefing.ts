import type { BriefingResult, CursorState, Reference } from "./schema.js";

export function renderMinimalPath(state: CursorState): string {
  return "CURRENT " + state.current_dir.path;
}

export function renderAncestorBriefing(briefing: BriefingResult): string {
  const entries = briefing.ancestry.map((entry, index) => {
    const work = entry.work;
    const lines = [
      String(index + 1) + ". " + entry.path + " — " + (work.title || work.kind),
      "   Objective: " + (work.objective || "not recorded"),
      "   State: " + (work.currentState || "not recorded"),
      "   Return when: " + (work.returnCondition || "not specified"),
    ];
    appendReferences(lines, work.refs);
    if (entry.closedChildOutcomes.length > 0) {
      lines.push("   Closed children: " + entry.closedChildOutcomes.join(", "));
    }
    return lines.join("\n");
  });
  const pending = briefing.pendingProposalCount > 0
    ? "Pending proposals: " + briefing.pendingProposalCount + ". Decide one before mutation."
    : "";
  return ["CONTEXT TREE BRIEFING", ...entries, pending].filter(Boolean).join("\n\n");
}

function appendReferences(lines: string[], references: Reference[]): void {
  for (const reference of references) {
    lines.push("   Evidence: " + reference.label + ": " + JSON.stringify(reference.value));
  }
}
