---
name: context-tree
description: Maintain explicit continuation context for nested Codex work using the Context Tree MCP tools.
---

Use Context Tree as the authoritative execution state for substantial work.

- Call getContext before broad searches for prior decisions or logs.
- At the first substantial user request, if the root still has the generic
  initialization text, call updateRecord to set its objective, rationale,
  and return condition.
- Create a child only when work gains an independently describable return
  condition; do not create nodes for mechanical commands.
- Every child needs a title and return condition. Close it with a summary when
  the condition is met, disproved, or abandoned.
- Treat the cursor as the active stack. After back or closeRecord, read the
  returned ancestorBriefing before continuing the parent scope.
- Keep material engineering facts in dated logs/ and mature conclusions in
  notes/; record their paths in node references. Context Tree is the
  continuation cursor and pointer layer, not the authority for those facts.
- After compaction, inspect the pending proposal's before/after state and
  explicitly apply, revise, or reject it before further tree mutations.
- Do not mark a root done while any descendant is open or blocked.
