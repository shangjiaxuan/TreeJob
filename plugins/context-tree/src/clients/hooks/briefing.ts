import type { BriefingResult, CursorState, Reference } from "../../protocol/schema.js";

export function renderMinimalPath(state: CursorState): string {
  return "CURRENT " + state.current_dir.path;
}

export function renderAncestorBriefing(briefing: BriefingResult): string {
  const entries = briefing.ancestry.map((entry, index) => {
    const work = entry.work;
    const lines = [
      String(index + 1) + ". " + entry.path + " — " + (work.title || work.kind),
      "   Objective: " + (work.objective || "not recorded"),
      "   Why: " + (work.rationale || "not recorded"),
      "   State: " + (work.currentState || "not recorded"),
      "   Open questions: " + (work.openQuestions.length > 0 ? work.openQuestions.join("; ") : "none"),
      "   Return when: " + (work.returnCondition || "not specified"),
    ];
    appendReferences(lines, work.refs);
    if (entry.closedChildOutcomes.length > 0) {
      lines.push("   Closed children:");
      for (const outcome of entry.closedChildOutcomes) {
        lines.push("     - " + outcome.path + " [" + outcome.status + "]: " + outcome.summary);
      }
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
