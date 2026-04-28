# Manual Test Plan

Per-task, step-by-step instructions to manually verify each implemented task.
One file per task. New tasks add a new file (`NN_<short-slug>.md`) and a row
to the index below — do **not** append sections to this README.

## Index

| Task | File |
| --- | --- |
| §Task 0 — Test Harness & Quality Gates | [`00_test-harness-and-quality-gates.md`](./00_test-harness-and-quality-gates.md) |
| §Task 1 — PolygonAreaJob | [`01_polygon-area-job.md`](./01_polygon-area-job.md) |
| §Task 3a — Workflow YAML `dependsOn` parsing, validation, transactional creation | [`03a_workflow-yaml-dependson-parsing-and-validation.md`](./03a_workflow-yaml-dependson-parsing-and-validation.md) |
| §Task 3b-i — Migrate `Job.run` to the `JobContext` signature | [`03b-i_migrate-job-run-to-jobcontext.md`](./03b-i_migrate-job-run-to-jobcontext.md) |
| §Pre-#7 — Worker infrastructure prelude | [`pre-7a_worker-infrastructure-prelude.md`](./pre-7a_worker-infrastructure-prelude.md) |
| §Pre-#7 — Shared test helpers | [`pre-7b_shared-test-helpers.md`](./pre-7b_shared-test-helpers.md) |
| §Task 3b-ii Wave 1 — Lifecycle refactor + initial → in_progress claim bump | [`03b-ii-wave-1_lifecycle-refactor-and-claim-bump.md`](./03b-ii-wave-1_lifecycle-refactor-and-claim-bump.md) |
| §Task 3b-ii Wave 2 — Readiness promotion + dependency envelope | [`03b-ii-wave-2_readiness-promotion-and-dependency-envelope.md`](./03b-ii-wave-2_readiness-promotion-and-dependency-envelope.md) |
| §Task 3b-ii Wave 3 — Fail-fast sweep + `workflow.failed` | [`03b-ii-wave-3_fail-fast-sweep-and-workflow-failed.md`](./03b-ii-wave-3_fail-fast-sweep-and-workflow-failed.md) |
| §Task 3c-i Wave 1 — JSON-line structured logger (US22) | [`03c-i_json-line-logger.md`](./03c-i_json-line-logger.md) |

## Naming convention

`NN[_subtask]_<short-slug>.md` — `NN` matches the README/PRD task number; sort
order is chronological by task. Pre-task preludes use the `pre-N` prefix
(e.g. `pre-7a_*.md`) so they sort before the task they unblock.
