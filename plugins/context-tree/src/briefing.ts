import type {
  Context,
  PayloadInode,
  Reference,
} from "./schema.js";

export function renderMinimalPath(context: Context): string {
  const path = context.activePath.map((record) => {
    const detail = record.currentState || record.returnCondition;
    return record.kind + ": " + record.title + " — " + detail;
  });

  return [
    "TASK STACK",
    ...path.map((entry, index) => String(index + 1) + ". " + entry),
  ].join("\n");
}

export function renderAncestorBriefing(context: Context): string {
  const entries = context.ancestorBriefing.map((entry, index) =>
    renderAncestor(index + 1, entry.record, entry.childOutcomes),
  );

  return [
    "CONTEXT TREE BRIEFING",
    ...entries,
    renderPendingProposals(context),
  ].filter(Boolean).join("\n\n");
}

function renderAncestor(
  depth: number,
  record: PayloadInode,
  childOutcomes: PayloadInode[],
): string {
  const lines = [
    String(depth) + ". " + record.kind.toUpperCase() + ": " + record.title,
    "   Objective: " + record.objective,
    "   Why: " + record.rationale,
    "   State: " + (record.currentState || "not yet recorded"),
    "   Return when: " + (record.returnCondition || "not specified"),
  ];

  appendQuestions(lines, record.openQuestions);
  appendReferences(lines, record.refs);
  appendOutcomes(lines, childOutcomes);

  return lines.join("\n");
}

function appendQuestions(lines: string[], questions: string[]): void {
  if (questions.length === 0) {
    return;
  }

  lines.push("   Open questions:");

  for (const question of questions) {
    lines.push("   - " + question);
  }
}

function appendReferences(lines: string[], references: Reference[]): void {
  if (references.length === 0) {
    return;
  }

  lines.push("   Evidence:");

  for (const reference of references) {
    lines.push(
      "   - " + reference.label + ": " + JSON.stringify(reference.value),
    );
  }
}

function appendOutcomes(lines: string[], outcomes: PayloadInode[]): void {
  if (outcomes.length === 0) {
    return;
  }

  lines.push("   Closed child outcomes:");

  for (const outcome of outcomes) {
    lines.push(
      "   - " + outcome.title + " [" + outcome.status + "]: " +
        outcome.currentState,
    );
  }
}

function renderPendingProposals(context: Context): string {
  if (context.pendingProposals.length === 0) {
    return "";
  }

  return "Pending proposals: " + context.pendingProposals.length +
    ". Decide one before further tree mutation.";
}
