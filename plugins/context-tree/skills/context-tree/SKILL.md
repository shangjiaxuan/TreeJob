---
name: context-tree
description: Maintain explicit continuation context for nested Codex work using the Context Tree MCP tools.
---

Use Context Tree as the authoritative execution state for substantial work.
It exposes one `command` MCP tool: send `{ sessionId, command: [...] }`, such
as `{ sessionId: "session", command: ["mkdir", "investigate", {"returnCondition":"Report findings"}] }`.

- Call `pwd` and, when needed, `briefing` before broad searches for prior decisions
  or logs.
- At the first substantial user request, if the root still has the generic
  initialization text, call `edit` to set its objective, rationale, and return
  condition.
- Create a child only when work gains an independently describable return
  condition; do not create nodes for mechanical commands.
- Every child needs a path name and return condition. Close it with a summary when
  the condition is met, disproved, or abandoned.
- Treat the cursor as the active stack. Use `ls`, `cd`, `mkdir`, and `mv` for tree
  navigation; `close` pops to the parent. Request `briefing` after compact or a
  significant detour.
- Public revisions are session snapshots (`r0`, `r1`, ...), not node IDs. Use
  `rev-list [path]` for semantic history and `rev-show <revision> [path]` for a
  historical view. A path normally resolves at the current head, so it follows
  a moved or renamed node; add `--reference=N` only when a historical path is
  the intended identity source.
- Do not infer storage details from revision output. Inode identities, node
  work history, link topology history, and their as-of resolvers are daemon
  internals. A session revision is the fixed historical view that selects the
  effective node and link states.
- Keep material engineering facts in dated logs/ and mature conclusions in
  notes/; record their paths in node references. Context Tree is the
  continuation cursor and pointer layer, not the authority for those facts.
- After compaction, inspect pending proposals and use `decide-proposal` to
  explicitly apply, replace, reject, or discard one before further tree mutations.
- Do not mark a root done while any descendant is open or blocked.
- For read-only inspection outside the agent loop, the optional local browser
  can show one existing session's workspace tree, node work, and revisions.
