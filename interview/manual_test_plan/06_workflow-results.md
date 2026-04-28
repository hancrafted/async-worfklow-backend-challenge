# §06 — `GET /workflow/:id/results` (Readme §6)

**Scripts:** `06_workflow-results_happy.sh`, `06_workflow-results_sad.sh`
**Backing tests:** `tests/06-workflow-results/`

## What the requirement is

Readme §6 asks for a `GET /workflow/:id/results` endpoint that returns:

- `200` with `{ workflowId, status: "completed", finalResult }` when the
  workflow has completed,
- `404` when the workflow id is unknown, and
- `400` when the workflow exists but is not yet completed.

In this codebase the third bullet is sharpened by issue **#22** into two
distinct 400 branches: `WORKFLOW_NOT_TERMINAL` (still running) and
`WORKFLOW_FAILED` (reached terminal but failed). The earlier lenient
implementation returned `200` for any terminal state including `failed`;
the post-#22 contract is **strict 400** for failed workflows. See
`interview/archive/manual_test_plan/06_workflow-results-endpoint.md` for
the design history.

## What the happy script proves

`06_workflow-results_happy.sh` posts the example workflow, waits for it to
reach `completed`, and asserts:

- the GET returns `200`;
- the body's `workflowId` matches and `status` is `"completed"`;
- `finalResult.tasks | length` equals **24** (every step represented in
  the synthesized payload — same envelope §04 asserts at the DB column).

The §04 happy script asserts the column was written; the §06 happy script
asserts the route surfaces it correctly to an HTTP client. The two are
complementary: §04 catches "transaction didn't write", §06 catches
"writer wrote but reader can't see it".

## What the sad script proves

`06_workflow-results_sad.sh` bundles **three** error branches per the
locked Round-10 Q2 amendment ("sad scripts may bundle multiple error-path
assertions when the requirement has more than one sad branch"):

1. **Unknown id** — fixed all-zeros UUID returns `404` with `error:
   "WORKFLOW_NOT_FOUND"`.
2. **Pending** — a freshly-created workflow returns `400` with `error:
   "WORKFLOW_NOT_TERMINAL"`. The check is intentionally racy against the
   worker pool; the 24-step DAG is large enough that the first GET catches
   the workflow before any task can complete on a real machine.
3. **Failed** — a workflow whose first step fails terminates as `failed`
   and the GET returns `400` with `error: "WORKFLOW_FAILED"` (post-#22
   strict contract).

Each branch captures its own `WORKFLOW_ID`; the script exits non-zero if
any branch fails (see `summarize` in `_lib.sh`).

## Why three branches in one script and not three scripts

The PRD's locked shell-script contract permits bundling multiple sad
branches when one route has multiple error modes (Round-10 Q2). Splitting
would triplicate boilerplate and obscure that all three branches share one
route's contract. The per-task `_sad.sh` semantics stay clean: one script
per requirement, exits non-zero on any failure, one `[PASS]`/`[FAIL]` line
per assertion.

## What to look for in the output

- `--- /results body ---` on the happy path prints the first 20 lines
  (`workflowId`, `status`, beginning of `finalResult`).
- Three `WorkflowId:` lines on the sad path (one per branch).
- One `[PASS]` per assertion; `summarize` prints the per-script line.

## What would change if it broke

- Happy `[FAIL]` on `200`: the route is rejecting a completed workflow
  (probably a regression in the `status === "completed"` guard).
- Sad `[FAIL]` on the failed branch: the route is back to lenient `200`
  for terminal-failed — a regression of issue **#22**.
- Sad `[FAIL]` on the pending branch with a `200`: the worker pool
  finished the workflow before the GET fired (rare; rerun on a colder DB).
