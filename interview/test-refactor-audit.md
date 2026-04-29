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

Tier C — pure rename, no mutation cycle.

## Phase 3 — §1 polygon-area

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|
| outputs-area-in-square-meters.test.ts | polygon-area.test.ts (`describe("happy")`) | src/jobs/PolygonAreaJob.ts: `area(geometry)` → `0` (return constant) | ✅ | ✅ | ✅ |
| handles-invalid-geojson-gracefully.test.ts | polygon-area.test.ts (`describe("error")`) | src/jobs/PolygonAreaJob.ts: validation `throw` guard removed (validate result discarded) | ✅ | ✅ | ✅ |

## Phase 4 — §2 report-generation

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|
| report-generation.test.ts (`describe("happy path: report aggregates upstream outputs")`) | report-generation.test.ts (`describe("happy path: report aggregates upstream outputs")`) | src/jobs/ReportGenerationJob.ts: `tasks: tasks` → `tasks: []` (drop aggregated entries from response) | ✅ | ✅ | ✅ |
| report-generation.test.ts (`describe("error path: defensive handling of malformed upstream envelopes")`) | report-generation.test.ts (`describe("error path: defensive handling of malformed upstream envelopes")`) | src/workers/taskRunner.ts: `JSON.parse(result.data)` wrapped in try/catch returning `null` (swallow corruption) | ✅ | ✅ | ✅ |

## Phase 5 — §3 + absorbed 03b-ii dependency sub-wave

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|
| tasks-can-be-chained-through-dependencies.test.ts (`describe("error path: invalid dependency graph rejected at creation time")`) | tasks-can-be-chained-through-dependencies.test.ts (`describe("error path: invalid dependency graph rejected at creation time")`) | src/workflows/dependencyValidator.ts: `detectDependencyCycle(...)` short-circuited to `return null` | ✅ | ✅ | ✅ |
| tasks-can-be-chained-through-dependencies.test.ts (`describe("happy path: N=3 workers, 1 queued task, exactly one execution")`) | tasks-can-be-chained-through-dependencies.test.ts (`describe("happy path: N=3 workers, 1 queued task, exactly one execution")`) | src/workers/taskWorker.ts: `claimTaskAndBumpWorkflow` claim guard removed (`WHERE status='queued'` dropped, `claim.affected !== 1` early-return removed) — atomic-claim primitive disabled | ✅ (`runSpy` called 3x) | ✅ (`runSpy` called 3x) | ✅ |
| 03b-ii-Dependency/01-lifecycle-claim-bump.test.ts (`describe("happy path")`) | lifecycle-claim-bump.test.ts (`describe("happy path")`) | src/workers/taskWorker.ts: workflow `initial→in_progress` UPDATE in `claimTaskAndBumpWorkflow` removed | ✅ | ✅ | ✅ |
| 03b-ii-Dependency/02-promotion-envelope.test.ts (`describe("happy path")`) | promotion-envelope.test.ts (`describe("happy path")`) | src/workers/taskRunner.ts: `promoteReadyTasks` `completedTaskIds` replaced with empty `Set<string>()` — promotion never fires | ✅ (`ranCount` = 1, expected 2) | ✅ (`ranCount` = 1, expected 2) | ✅ |
| 03b-ii-Dependency/03-fail-fast-sweep.test.ts (`describe("happy path")`, `describe("error path")`) | fail-fast-sweep.test.ts (`describe("happy path")`, `describe("error path")`) | src/workers/taskRunner.ts: `sweepFailedSiblings` body removed (UPDATE + in-memory mirror both gone) | ✅ (siblings stay `waiting`) | ✅ (siblings stay `waiting`) | ✅ |

## Phase 6 — §4 final-result

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|
| final-result.test.ts (`describe("happy path: completed workflow gets framework-synthesized finalResult")`) | final-result.test.ts (`describe("happy path: completed workflow gets framework-synthesized finalResult")`) | src/workflows/synthesizeFinalResult.ts: `entry.output = parseOutputOrNull(result)` → result discarded (assignment dropped) | ✅ | ✅ | ✅ |
| final-result.test.ts (`describe("error path: mixed-failure workflow surfaces failedAtStep and per-task errors")`) | final-result.test.ts (`describe("error path: mixed-failure workflow surfaces failedAtStep and per-task errors")`) | src/workflows/synthesizeFinalResult.ts: `if (failedSteps.length > 0) payload.failedAtStep = Math.min(...failedSteps)` removed | ✅ | ✅ | ✅ |

## Phase 7 — §5 workflow-status

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|
| workflow-status.test.ts (`describe("happy path: status returns workflow + per-task list keyed by stepNumber")`) | workflow-status.test.ts (`describe("happy path: status returns workflow + per-task list keyed by stepNumber")`) | src/routes/workflowRoutes.ts: `completedTasks = tasks.filter(... === Completed).length` → `completedTasks = 0` | ✅ | ✅ | ✅ |
| workflow-status.test.ts (`describe("error path: workflow not found")`) | workflow-status.test.ts (`describe("error path: workflow not found")`) | src/routes/workflowRoutes.ts: status-handler 404 → 500 in the `if (!workflow)` `errorResponse(...)` call | ✅ | ✅ | ✅ |

## Phase 8 — §6 workflow-results

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|
| workflow-results.test.ts (`describe("happy path: terminal workflows return finalResult")`) | workflow-results.test.ts (`describe("happy path: terminal workflows return finalResult")`) | src/routes/workflowRoutes.ts: `/results` 200 response `finalResult` → `{ ...finalResult, tasks: [] }` (drop synthesized task entries) | ✅ | ✅ | ✅ |
| workflow-results.test.ts (`describe("error path: workflow failed")`) | workflow-results.test.ts (`describe("error path: workflow failed")`) | src/routes/workflowRoutes.ts: `WORKFLOW_FAILED` `errorResponse(...)` 400 → 500 | ✅ | ✅ | ✅ |

## Phase 9

Co-located the 5 unit-test files next to their `src/` SUT modules. Three are
byte-equivalent ports (Tier B); two are merges (Tier A) — one merge per shared
module. Mutation cycles below: 3 Tier-B (one per port) + 4 Tier-A (one per
merged source file's coverage). Old `/tests/` files left untouched (verified
via `git diff tests/`).

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|
| error-response.unit.test.ts (`describe("happy path: emits { error, message } …")`) | src/utils/errorResponse.test.ts (same describe) | src/utils/errorResponse.ts: `res.status(status).json({ error: code, message })` → `{ error: "WRONG", message }` | ✅ | ✅ | ✅ |
| workflow-factory.unit.test.ts (`describe("happy path: persists workflow + tasks atomically with the right waiting/queued mix")`) | src/workflows/WorkflowFactory.test.ts (same describe) | src/workflows/WorkflowFactory.ts: `buildTasks` `task.status = dependsOn.length === 0 ? Queued : Waiting` → `task.status = TaskStatus.Queued` (every task starts queued) | ✅ | ✅ | ✅ |
| synthesize-final-result.unit.test.ts (`describe("synthesizeFinalResult — happy path")`) | src/workflows/synthesizeFinalResult.test.ts (same describe) | src/workflows/synthesizeFinalResult.ts: `[...tasks].sort((a, b) => a.stepNumber - b.stepNumber)` → `[...tasks]` (ascending sort dropped) | ✅ | ✅ | ✅ |
| cycle-detector.unit.test.ts (`describe("detectDependencyCycle — pure DAG / cycle / self-dep checker")`) | src/workflows/dependencyValidator.test.ts (same top-level describe) | src/workflows/dependencyValidator.ts: `detectDependencyCycle` short-circuited to `return null` (every graph reported as a DAG) | ✅ | ✅ | ✅ |
| dependency-validator.unit.test.ts (`describe("validateWorkflowSteps — in-memory dependency validator")`) | src/workflows/dependencyValidator.test.ts (same top-level describe) | src/workflows/dependencyValidator.ts: `validateWorkflowSteps` skip `checkReferences` (missing-step + cycle gate dropped) | ✅ | ✅ | ✅ |
| dependson-translator.unit.test.ts (`describe("translateDependsOnToStepNumbers — pure helper (Task 5, US16)")`) | src/routes/workflowRoutes.test.ts (same top-level describe) | src/routes/workflowRoutes.ts: `translateDependsOnToStepNumbers` map body → `return 0` (lookup + orphan throw collapsed) | ✅ | ✅ | ✅ |
| lazy-patch-final-result.unit.test.ts (`describe("applyLazyFinalResultPatch — pure helper (Task 6, lazy patch)")`) | src/routes/workflowRoutes.test.ts (same top-level describe) | src/routes/workflowRoutes.ts: `applyLazyFinalResultPatch` UPDATE WHERE clause `finalResult: IsNull()` removed (pre-populated finalResult overwritten) | ✅ | ✅ | ✅ |

## Phase 10

Cutover only — archive + rename + config revert. No mutation cycles.

Cutover ran: old `/tests/` archived to `/interview/archive/tests/` (preserving git history via `git mv`), `/test/` renamed to `/tests/`, dual-include reverted in `vitest.config.ts` / `tsconfig.eslint.json` / `eslint.config.js`, and `interview/archive/**` excluded from all three tools (eslint, typecheck, vitest).
