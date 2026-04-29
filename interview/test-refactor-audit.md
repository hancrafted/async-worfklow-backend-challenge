# Test Folder Refactor — Audit Log

> Mutation-anchored equivalence evidence for the `/tests/` → `/test/` →
> `/tests/` refactor described in `plan/TEST_REFACTOR_PRD.md`. One H2
> section per phase; Tier-A and Tier-B mutation cycles are recorded as
> rows in the per-phase table. Mutated SUT code is never committed — the
> rows below are the only artifact.
>
> Column legend (per `plan/TEST_REFACTOR_PRD.md` §"Audit log format"):
> - **Old file(s)** — path under `/tests/` (and `describe` block, if any)
>   that the mutation targeted.
> - **New file** — path under `/test/` (and `describe` block, if any)
>   that the mutation targeted.
> - **Mutation** — `src/<sut>` location and the change applied.
> - **Old red?** — did the legacy test go red on the mutation?
> - **New red?** — did the new test go red on the mutation?
> - **Reverted clean?** — did `git checkout src/<sut>` restore green on
>   both suites?

## Phase 0

Scaffold only — no mutation cycles. Config diffs, `/test/` skeleton, and
this audit-log file land in the Phase 0 commit.

## Phase 1

Tier-B mutation cycles for the four shared helpers copied into
`test/_setup/helpers/`. The old umbrella suite
(`tests/03-interdependent-tasks/helpers/helpers.unit.test.ts`) and its
new sibling (`test/_setup/helpers/helpers.test.ts`) cover three of the
four helpers directly; `drainPool` has no consumer under `test/_setup/`
yet (Phase 5 ports the chain test that exercises it), so its row uses
the legacy chain test as the behavioural anchor and proves the new
copy's equivalence via `diff` byte-identity.

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|
| helpers.unit.test.ts (drainWorker happy + error) | helpers.test.ts (drainWorker happy + error) | src/workers/taskWorker.ts: `tickOnce` final `return true` → `return false` | ✅ | ✅ | ✅ |
| helpers.unit.test.ts (seedWorkflow happy via `expect(tasks).toHaveLength(3)`) | helpers.test.ts (seedWorkflow happy via `expect(tasks).toHaveLength(3)`) | src/workflows/WorkflowFactory.ts: `persistAtomically` skips `Task` save | ✅ | ✅ | ✅ |
| helpers.unit.test.ts (mockJobsByType error: `toThrow(/no job registered.../)`) | helpers.test.ts (mockJobsByType error: `toThrow(/no job registered.../)`) | mockJobsByType.ts (both copies, identical patch): missing-job branch silently returns no-op job instead of throwing | ✅ | ✅ | ✅ |
| tasks-can-be-chained-through-dependencies.test.ts (`expect(executed).toBe(3)`) | _no consumer in `test/_setup/` yet — Phase 5 ports the chain test_ | drainPool.ts (both copies, identical patch — byte-identity verified via `diff`): `onExecuted` flips `executed += 1` → `executed -= 1` | ✅ (`-3 ≠ 3`) | n/a (Phase 5) — byte-identity ✅ | ✅ |

## Phase 2

## Phase 3

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|

## Phase 4

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|

## Phase 5

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|

## Phase 6

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|

## Phase 7

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|

## Phase 8

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|

## Phase 9

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|

## Phase 10

Cutover only — archive + rename + config revert. No mutation cycles.
