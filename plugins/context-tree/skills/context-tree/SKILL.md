---
name: context-tree
description: Maintain explicit continuation context for nested Codex work using the Context Tree MCP tools.
---

Use Context Tree as the authoritative execution state for substantial work.

- Call `get_context` before broad searches for prior decisions or logs.
- Create a child only when work gains an independently describable return condition; do not create nodes for mechanical commands.
- Every child needs a title and return condition. Close it with a summary when the condition is met, disproved, or abandoned.
- Treat the cursor as the active stack. Use `back` after closing a detour.
- After compaction, inspect the pending proposal's before/after state and explicitly apply, revise, or reject it before further tree mutations.
- Do not mark a root done while any descendant is open or blocked.
