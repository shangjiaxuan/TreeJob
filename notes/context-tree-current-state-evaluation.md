# Context Tree current-state review

Date: 2026-09-14

## Verdict

Context Tree is now a credible path toward long-context local development. Its
core abstraction remains strong: the active path is a compact, always-on answer
to "what am I doing?", while node work fields can preserve the fuller why,
constraints, evidence, and detour outcomes. The interactive shell and
read-only browser make that workflow testable outside a live Codex session.

The v6 storage refactor also behaved correctly in a manual daemon exercise:
a child session forked at a task stayed frozen at its pre-move path and work
state after the parent moved that task elsewhere. Revision history reported the
expected work and move changes.

This is not yet ready to be relied on daily. The remaining issues are mostly
well-scoped workflow and release-boundary fixes, rather than evidence against
the task-stack model.

## Source versus deploy artifact

Keep `dist/` and generated output out of the source repository. They should
be produced by a deployment job that creates a runnable plugin artifact.

The separate issue is that `test/core.test.ts` was accidentally removed while
`build.mjs` still bundles it. Restore and track test *source*, while continuing
to ignore generated test bundles. The deploy job should run, from a clean source
checkout:

1. `npm ci`
2. generate contracts
3. typecheck
4. build the artifact
5. run tests
6. validate the staged artifact, including MCP and hook launch files

The source checkout itself need not be directly installable if the deployment
contract is clear and exercised in CI.

## Findings to fix before a daily trial

1. Restore briefing fidelity.

   `renderAncestorBriefing` renders objective, state, return condition,
   references, and closed-child titles, but not `rationale`, open questions,
   or a closed child's status/summary. A compact/resume briefing should include
   the explicit why and the implication of a completed detour, not merely its
   name.

2. Restore reliable root initialization.

   New roots now have blank work fields, but the skill says to initialize only
   when an old generic initialization string is present. Trigger initialization
   when root objective/rationale/return condition are blank, or restore a
   deliberate detectable placeholder.

3. Preserve terminal-tree invariants.

   `edit` accepts `status`, bypassing `close`'s check that descendants are
   terminal. Either reserve terminal status changes for `close`, or apply the
   same validation and cursor behavior to `edit`.

4. Make resume and retry transport safe.

   SessionStart's idempotency key omits `cwd`, so a replay can bypass the
   session's workspace validation. Include canonical workspace identity in the
   key or perform validation outside the replayed operation.

   RPC retries resend shell/MCP mutations without a durable idempotency key.
   Generate one key per logical command and reuse it on retry; only start the
   daemon when the endpoint is unavailable, not after every command error.

5. Improve recovery search and compaction handling.

   Search currently misses open questions, return conditions, references, and
   metadata—the fields most likely to point back to logs, notes, provenance,
   and pending decisions. The compact hook still reads a trailing transcript
   window instead of an unreconciled delta; use the journal offset it already
   records.

6. Clarify disposable-shell behavior.

   `--ephemeral` currently behaves like the already-default random temporary
   directory and does not remove it at exit. Either clean it up or name the
   behavior "isolated" rather than disposable.

## Tests worth restoring or adding

- Clean-source deployment artifact test: source has no `dist`, staging artifact
  has all runtime files, and MCP/hook launch successfully.
- Shell scenario: `/goal/job/task/investigation`, close the investigation, then
  verify `briefing` presents path, why, outcome, questions, and evidence.
- Hook scenario: SessionStart after compact and a changed cwd; assert a correct
  briefing and workspace mismatch protection.
- Terminal-state test: an open descendant prevents every terminal transition,
  including through `edit`.
- Retry test: simulate a lost response after a mutation and prove one revision
  is written.
- v6 regression suite: frozen fork behavior, path rename/move, history views,
  browser cold start, escaped names, and workspace/global search.

## Recommended home order

First restore the test source and build/deploy boundary. Next fix the briefing
and root trigger, because those directly determine whether the plugin solves
the long-context problem. Then harden status, cwd, and retry semantics. Use the
shell as the acceptance harness throughout, before growing the browser or hook
surface further.

The current path is already useful as a lossy structural reminder. Once the
resume packet reliably includes rationale and detour consequences, it should be
well suited to preserving intent through implementation-heavy compactions.
