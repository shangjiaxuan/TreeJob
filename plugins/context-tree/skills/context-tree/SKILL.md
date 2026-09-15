---
name: context-tree
description: Maintain explicit continuation context for nested Codex work using the Context Tree MCP tools.
---

Use Context Tree as the authoritative execution state for substantial work.
It exposes one `command` MCP tool: send `{ sessionId, command: [...] }`, such
as `{ sessionId: "session", command: ["mkdir", "investigate", {"returnCondition":"Report findings"}] }`.

- Call `pwd` and, when needed, `briefing` before broad searches for prior decisions
  or logs.
- At the first substantial user request, inspect `pwd`. If the root objective,
  rationale, or return condition is blank, call `edit` to set all three.
- Create a child only when work gains an independently describable return
  condition; do not create nodes for mechanical commands.
- Every child needs a path name and return condition. Close it with a summary when
  the condition is met, disproved, or abandoned.
- Treat the cursor as the active stack. Use `ls`, `cd`, `mkdir`, and `mv` for tree
  navigation; `close` pops to the parent. Request `briefing` after compact or a
  significant detour.
- Public revisions are session revisions (`r0`, `r1`, ...), not node IDs. Use
  `rev-list [path]` for semantic history and `rev-show [revision] [path]` for a
  current-head or historical view. Add `--verbose` only when the originating session/revision
  view for a node state is needed. Use `query-link parent [path]` or
  `query-link child [path]` for stable directory-link history. A path normally
  resolves at the current head, so it follows a moved or renamed node; add
  `--reference=N` only when a historical path is the intended identity source.
- Do not infer storage details from revision output. Inode and link identities,
  shared mainline records, private session overlays, and owner mailboxes
  are daemon internals. A session revision is the fixed historical view that
  selects effective published node and link records; diagnostic events are not
  part of state resolution.
- Keep material engineering facts in dated logs/ and mature conclusions in
  notes/; record their paths in node references. Context Tree is the
  continuation cursor and pointer layer, not the authority for those facts.
- After compaction, inspect the injected compact proposal and use
  `decide-proposal` to explicitly apply, replace, reject, or discard it before
  further tree mutations. The decision response describes the affected node,
  not unrelated current work; use `pwd` when the full active work is needed.
- Do not mark a root done while any descendant is open or blocked.
- For read-only inspection outside the agent loop, the optional local browser
  can show one existing session's workspace tree, node work, and revisions.
