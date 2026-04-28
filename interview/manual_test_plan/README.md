# Manual Test Plan

Per-task, step-by-step instructions to manually verify each implemented task.
One file per task. New tasks add a new file (`NN_<short-slug>.md`) and a row
to the index below — do **not** append sections to this README.

## Index

| Task | File |
| --- | --- |
| §Task 0 — Test Harness & Quality Gates | [`00_test-harness-and-quality-gates.md`](./00_test-harness-and-quality-gates.md) |
| §Task 1 — PolygonAreaJob | [`01_polygon-area-job.md`](./01_polygon-area-job.md) |
| §Task 2 — ReportGenerationJob | [`02_report-generation-job.md`](./02_report-generation-job.md) |
| §Task 3a — Workflow YAML `dependsOn` parsing, validation, transactional creation | [`03a_workflow-yaml-dependson-parsing-and-validation.md`](./03a_workflow-yaml-dependson-parsing-and-validation.md) |
| §Task 3b-i — Migrate `Job.run` to the `JobContext` signature | [`03b-i_migrate-job-run-to-jobcontext.md`](./03b-i_migrate-job-run-to-jobcontext.md) |
| §Pre-#7 — Worker infrastructure prelude | [`pre-7a_worker-infrastructure-prelude.md`](./pre-7a_worker-infrastructure-prelude.md) |
| §Pre-#7 — Shared test helpers | [`pre-7b_shared-test-helpers.md`](./pre-7b_shared-test-helpers.md) |
| §Task 3b-ii Wave 1 — Lifecycle refactor + initial → in_progress claim bump | [`03b-ii-wave-1_lifecycle-refactor-and-claim-bump.md`](./03b-ii-wave-1_lifecycle-refactor-and-claim-bump.md) |
| §Task 3b-ii Wave 2 — Readiness promotion + dependency envelope | [`03b-ii-wave-2_readiness-promotion-and-dependency-envelope.md`](./03b-ii-wave-2_readiness-promotion-and-dependency-envelope.md) |
| §Task 3b-ii Wave 3 — Fail-fast sweep + `workflow.failed` | [`03b-ii-wave-3_fail-fast-sweep-and-workflow-failed.md`](./03b-ii-wave-3_fail-fast-sweep-and-workflow-failed.md) |
| §Task 4 — Workflow `finalResult` synthesis with eager write | [`04_workflow-final-result-synthesis.md`](./04_workflow-final-result-synthesis.md) |
| §Task 5 — `GET /workflow/:id/status` endpoint | [`05_workflow-status-endpoint.md`](./05_workflow-status-endpoint.md) |
| §Task 6 — `GET /workflow/:id/results` endpoint | [`06_workflow-results-endpoint.md`](./06_workflow-results-endpoint.md) |
| §Task 3c-i Wave 1 — JSON-line structured logger (US22) | [`03c-i_json-line-logger.md`](./03c-i_json-line-logger.md) |
| §Task 3c-ii Wave 2 — Loop-of-last-resort + transient runner errors (US21) | [`03c-ii_loop-of-last-resort.md`](./03c-ii_loop-of-last-resort.md) |
| §Task 3c-iii Wave 3 — In-process worker pool + complex example workflow (US17, US18, US20) | [`03c-iii_worker-pool-and-complex-example.md`](./03c-iii_worker-pool-and-complex-example.md) |
| §Task 7 — Default `WORKER_POOL_SIZE=1` + SQLite concurrency ceiling | [`07_worker-pool-default-1-and-sqlite-ceiling.md`](./07_worker-pool-default-1-and-sqlite-ceiling.md) |
| Issue #17 Wave 1 — Production fix: per-worker DataSources + WAL | [`17a_per-worker-datasources-production.md`](./17a_per-worker-datasources-production.md) |

## Naming convention

`NN[_subtask]_<short-slug>.md` — `NN` matches the README/PRD task number; sort
order is chronological by task. Pre-task preludes use the `pre-N` prefix
(e.g. `pre-7a_*.md`) so they sort before the task they unblock.
