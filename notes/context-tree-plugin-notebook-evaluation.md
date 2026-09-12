# Context Tree (TreeJob) local-development notebook evaluation

Date: 2026-09-12

Status: working evaluation. This records current implementation evidence; it
does not adopt the plugin as a workspace policy or replace the `logs/` ->
`notes/` retention model.

## Question and intended use

Evaluate `E:\Source\TreeJob\plugins\context-tree` as a local, persistent
task-stack notebook. The intended hierarchy is:

```text
goal -> plan -> job -> detour
```

Each level should answer what is being done, why it matters, what remains,
and what must be true before returning to its parent. Returning from a detour
should refresh the larger scope with the detour outcome and relevant notes.

## Evidence that supports the model

- The implementation stores arbitrary record `kind`, `title`, `objective`,
  `rationale`, `currentState`, `openQuestions`, `returnCondition`, `refs`, and
  `metadata` fields in a local SQLite snapshot tree. `kind` can represent the
  four intended levels without a schema change.
- `pushChild`, `enter`, `back`, `updateRecord`, and `closeRecord` maintain an
  active cursor path. Closing a child writes its summary into `currentState`
  and normally moves the cursor to the parent. Terminal descendants are
  required before closing a parent.
- A direct daemon exercise created a plan, job, and detour; closing the
  detour returned the cursor to the job. The returned job context retained the
  closed detour as a child with its summary, objective, and rationale. A
  further `back` returned the cursor to the plan.
- The implementation has copy-on-write snapshots, explicit compact and
  subagent proposals, a per-session cursor, and session-start hook output.
  These are useful safeguards for a transient execution notebook.

## Gaps against the notebook goal

1. The data model can answer “what” and “why” (`objective` and `rationale`),
   but the automatic session-start refresh emits only each active record's
   title plus `currentState` or `returnCondition`. It omits objective,
   rationale, open questions, references, and child/detour outcomes. The
   automatic refresh therefore does not yet answer the two central questions.
2. The bundled skill says to call `get_context`, while the actual MCP tool is
   named `getContext`. It also does not require initialization of the root
   objective/rationale after the first user request. A new root starts with
   the generic “Initialize the continuation objective.”
3. `back` returns the complete raw context to a caller that invokes it, but it
   does not create a focused larger-scope briefing. The agent must explicitly
   read the returned parent fields and closed-child summaries.
4. Context search indexes only title, objective, and current state. It does
   not search `rationale`, open questions, return condition, references, or
   metadata. In the direct exercise, a session-tree search for words stored
   only in rationale returned no result.
5. The `PreCompact` implementation reads the last 48 KiB of the transcript on
   every compact rather than an unsummarized offset range. Its JSON output
   schema permits `summary`, but the strict `PayloadPatch` parser does not;
   a worker using that permitted field is rejected. On resume, the hook reports
   only a pending-proposal count, not the proposal before/after detail or a
   required decision.
6. Subagent completion becomes a scalar parent proposal based on the last
   assistant message. Structural child-tree merge is intentionally deferred,
   so it cannot preserve a rich subagent notebook branch without manual
   distillation.
7. State is local under `%LOCALAPPDATA%\ContextTree`, keyed by canonical
   workspace path. It stores neither the active Git branch/commit nor native
   SVN checkpoint. Branches with separate local scopes can therefore share
   stale notebook search state at the same checkout path.
8. The checked-in local-marketplace plugin is not runnable from a fresh clone:
   `.mcp.json` and hooks call `dist/*.mjs`, but `dist/` is ignored and absent
   from Git. There is no install-time build step. The README's claim that the
   bundled runtime is available is not true for the checked-in tree.

## Validation performed

- On the available Node 24 runtime, `npm ci --ignore-scripts`, `npm run
  typecheck`, `npm test`, and `npm run validate` all passed in
  `E:\Source\TreeJob\plugins\context-tree`.
- The test suite contains nine core model/schema tests. It does not exercise
  an installed marketplace plugin, actual hooks, MCP STDIO integration,
  compaction-worker success/failure, or durable notebook behavior across a
  real Codex session.
- The built `dist/` and `node_modules/` directories are ignored and were left
  untracked in `E:\Source\TreeJob`; no tracked plugin or Echo source file was
  changed. Temporary manual daemon state was removed.

## Scoped conclusion

Context Tree is promising as a **local execution cursor** for a deliberate
goal/plan/job/detour discipline. It is not yet a dependable development
notebook that automatically preserves or restores “what am I doing?” and
“why am I doing it?”

Do not make it the authority for engineering facts. Continue writing material
findings, corrections, handoffs, and abandoned paths immediately to dated
`logs/` records, then distill mature scoped conclusions into `notes/`.
If the plugin is advanced, its authority should be limited to current task
navigation and concise pointers into those records.

Before a trial as a daily local tool: package the runtime; repair the MCP skill
names; require root objective/rationale/return condition; make `back` and
session-start produce a concise ancestor briefing with relevant child outcomes
and references; search all notebook fields; repair compact proposal handling;
and bind each notebook session to branch, Git commit, and SVN checkpoint.

## Validation-artifact correction — 2026-09-12

After recording the validation result, the ignored `node_modules/` and `dist/`
directories created solely for this evaluation were removed from
`E:\Source\TreeJob\plugins\context-tree`. The TreeJob tracked worktree is
clean again. Their removal reinforces, rather than changes, the fresh-clone
packaging finding above: the checked-in marketplace plugin still has no runtime
artifact for its MCP server or hooks.

## Scope correction: task-tree provenance is sufficient — 2026-09-12

The prior evaluation overstated the lack of automatic Git-branch, commit, and
SVN-checkpoint identity as a reason that Context Tree could not serve as the
local notebook. The intended unit is a task path, not a global workspace
record:

```text
/goalN/jobN/taskN/investigationN
```

Branch attribution, related branches, source revisions, and evidence links can
belong on the relevant goal, job, task, or investigation record through its
existing `refs` and `metadata` fields. That is often more accurate than a
single workspace-wide branch field because one local session can investigate
several scoped lines.

The actual need is to prevent a long, implementation-detail-heavy post-compact
transcript from hiding the higher-level objective and rationale. Context Tree's
active ancestry is the right model for that: every compact/resume and every
return from a detour should present a concise ancestor briefing containing the
goal, why, branch/provenance note where relevant, current plan/job, completed
detour outcome, return condition, open questions, and pointers to material
`logs/`/`notes/` records.

The current implementation already persists the needed fields and cursor path.
Its shortcoming is the projection used by the hook: it emits title plus current
state/return condition, omitting objective, rationale, refs, and questions.
Therefore the priority is a richer task-stack restore/`back` briefing and
root-record initialization, not making branch identity a mandatory global
database key. The earlier warning remains relevant only as a non-automatic
guardrail: the plugin cannot itself detect or validate a branch switch unless
the task record and its resume briefing surface that provenance.

## Practical verdict for long implementation sessions — 2026-09-12

The user clarified that Context Tree is deliberately a persistent task stack:
the level-local record, rather than a global workspace record, answers both
"What am I doing?" and "Why am I doing it?" after the recent transcript has
narrowed into implementation detail. That is the right abstraction for this
workflow. A node may carry branch attribution, related branches, revisions,
and links to dated evidence when those facts matter to that scope.

The current plugin will already help an agent navigate consciously among
`/goalN/jobN/taskN/investigationN`, retain closed-detour outcomes, and return
to a parent cursor. It will not yet reliably restore the higher-level meaning
automatically after compaction because the SessionStart rendering leaves out
the stored objective and rationale. The smallest high-value change is a compact
ancestor briefing on SessionStart and `back`: goal + rationale; relevant
provenance; current job/state/return condition; finished-detour implication;
open questions; and `logs/`/`notes/` pointers. The combined skill, MCP server,
and lifecycle-hook shape is consistent with OpenAI's documented plugin
architecture; the missing behavior is Context Tree's briefing policy, not an
architectural mismatch.

## Nuance: the current path is already partial restoration — 2026-09-12

The current path is not empty or useless after compaction. Its ordered node
titles, plus each node's current state or return condition, already encode a
compact structural answer to "what am I doing?" and can indirectly encode
"why?" when titles and state are written with that intent. The correct finding
is that this is lossy, not that the hook loses all higher-level context.

The richer ancestor briefing remains valuable because the durable `objective`
and `rationale` fields make the reason explicit rather than depending on title
wording, while completed-detour implications, open questions, and evidence
pointers are otherwise absent. The current path should be treated as the
minimal always-on task-stack reminder; a richer rendering should be an
incremental improvement, not a prerequisite for usefulness.

## Proposed next home experiment: interactive shell — 2026-09-12

Before expanding hooks or adding UI, add a development-only interactive shell
over the same daemon/model API. It should make the task-stack workflow easy to
exercise manually: initialize/show the current path, create or enter a child,
update the current record, close a detour with a summary, go back, search, and
render both the existing minimal path and a proposed richer ancestor briefing.
Use an explicit disposable database/session option so the shell is a realistic
integration harness without creating a second persistence implementation.

The acceptance test is experiential: create
`/goalN/jobN/taskN/investigationN`, write a meaningful why at the goal/job
level, close the investigation, return twice, and verify that each displayed
scope makes the next action and its reason obvious without rereading a
transcript. This will validate whether the present path is sufficient and
which extra fields genuinely earn space in a resume briefing.
