# Manual Test Plan

This folder is the **manual** verification surface for the six original
Readme.md requirements (§1–§6). Each requirement has:

- one `_happy.sh` script (and, except for §03a, one `_sad.sh` script), and
- one `*.md` rationale that explains *what the script proves* and *why
  these assertions* — without re-printing the curl/sqlite/jq plumbing that
  already lives in the script.

For the full reviewer-facing narrative (orientation, design digest,
verification table) see [`/interview.md`](../../interview.md). For the
locked planning context see [`/plan/INTERVIEW_PRD.md`](../../plan/INTERVIEW_PRD.md).

## How to run

Two-terminal pattern (locked Round-10 Q6):

1. **Terminal A** — `npm start` (server + worker pool on `:3000`).
2. **Terminal B** — `./interview/manual_test_plan/<script>.sh` for an
   individual script, or `for s in interview/manual_test_plan/0*.sh; do
   "$s" || echo BROKEN; done` for the full sweep. Zero `BROKEN` lines is
   the green bar.

Each script captures its own `WORKFLOW_ID` and filters every assertion by
it (workflowId-scoped hermeticity, locked Round-10 Q7), so scripts may run
in any order and may share a server with prior runs.

## Index

| README req | Rationale | Happy | Sad |
|---|---|---|---|
| §1 PolygonAreaJob | [`01_polygon-area.md`](./01_polygon-area.md) | `01_polygon-area_happy.sh` | `01_polygon-area_sad.sh` |
| §2 ReportGenerationJob | [`02_report-generation.md`](./02_report-generation.md) | `02_report-generation_happy.sh` | `02_report-generation_sad.sh` |
| §3 Workflow YAML `dependsOn` | [`03a_workflow-yaml-dependson.md`](./03a_workflow-yaml-dependson.md) | `03a_workflow-yaml-dependson_happy.sh` | — (see [`tests/03a-workflow-yaml-dependson/`](../../tests/03a-workflow-yaml-dependson/)) |
| §4 `Workflow.finalResult` | [`04_workflow-final-result.md`](./04_workflow-final-result.md) | `04_workflow-final-result_happy.sh` | `04_workflow-final-result_sad.sh` |
| §5 `GET /workflow/:id/status` | [`05_workflow-status.md`](./05_workflow-status.md) | `05_workflow-status_happy.sh` | `05_workflow-status_sad.sh` |
| §6 `GET /workflow/:id/results` | [`06_workflow-results.md`](./06_workflow-results.md) | `06_workflow-results_happy.sh` | `06_workflow-results_sad.sh` |

Total: **6 rationale `.md` + 11 scripts** (6 happy + 5 sad). §03a sad-path
coverage lives in the integration test suite, not as a shell script — see
the rationale file for why.

## Helpers

All scripts source [`_lib.sh`](./_lib.sh) for the shared assertion and
fixture helpers (`require_server`, `post_analysis`, `wait_terminal`,
`assert_eq`, `assert_jq`, `assert_http_status`, `assert_sqlite_eq`,
`summarize`, plus the `VALID_POLYGON` / `INVALID_POLYGON` fixtures). The
helpers are the single point where curl/sqlite/jq plumbing lives — the
per-task scripts read like test cases, not test plumbing.

## Archived predecessors

The pre-rebuild `.md` files (one per task **plus** waves like 03b/03c/17)
are preserved under [`../archive/manual_test_plan/`](../archive/manual_test_plan/)
for audit. Do not cite them as the current state — see
[`../archive/CLAUDE.md`](../archive/CLAUDE.md).
