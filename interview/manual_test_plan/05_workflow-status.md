# §05 — `GET /workflow/:id/status` (Readme §5)

**Scripts:** `05_workflow-status_happy.sh`, `05_workflow-status_sad.sh`
**Backing tests:** `tests/05-workflow-status/`

## What the requirement is

Readme §5 asks for a `GET /workflow/:id/status` endpoint that returns:

- `200` with `{ workflowId, status, completedTasks, totalTasks }` for an
  existing workflow, and
- `404` for an unknown workflow id.

The route additionally surfaces the per-task array (with `stepNumber` and
`dependsOn`) used by §03a — that contract is not new in §05; the §05
scripts only assert the headline counters and the 404 envelope.

## What the happy script proves

`05_workflow-status_happy.sh` posts the example workflow and asserts:

- the **first** GET (immediately after creation, before any worker tick)
  returns **200** with the correct shape — proving the endpoint is wired
  before the workflow has reached any terminal state;
- `workflowId` echoes the id we just created (proves we are reading the
  right row);
- `totalTasks` is **24** even on the initial read — proving the counter
  reflects the full DAG, not "currently visible" tasks;
- after `wait_terminal` finishes, `status` is `completed`,
  `completedTasks` is `24`, and `totalTasks` is still `24`.

The "before / after" pair (initial read while in-progress, second read
after terminal) is what proves the endpoint is monotonic and stable, not a
snapshot of one phase.

## What the sad script proves

`05_workflow-status_sad.sh` issues a GET against a fixed
all-zeros UUID and asserts:

- the response is `404`;
- the body matches the canonical error envelope `{ error:
  "WORKFLOW_NOT_FOUND", message: "<non-empty>" }`.

The fixed id (`00000000-0000-0000-0000-000000000000`) is deliberate — no
real workflow can ever collide with it under uuid-v4 generation, so the
script is hermetic against any DB state on the running server.

## Why we pin the error code, not just the status

A `404` with no body, a `404` with `{ error: "NOT_FOUND" }`, and a `404`
with `{ error: "WORKFLOW_NOT_FOUND" }` are all valid HTTP-spec responses
but only the third matches the contract this codebase publishes. Pinning
the `error` enum value catches the "I changed the constant and forgot to
update one of the routes" class of regression, which a status-only check
would miss.

## What to look for in the output

- `--- initial /status ---` shows the first 8 lines of the body so the
  reviewer can eyeball the shape (`workflowId`, `status`, `totalTasks`,
  `completedTasks`).
- `--- error body ---` on the sad path shows the full 404 envelope.
- One `[PASS]` per assertion; `summarize` prints `[PASS] §05 happy/sad
  path`.

## What would change if it broke

- Happy `[FAIL]` on the initial `200`: the route is gated on workflow
  status (e.g. only returns 200 once terminal) — that violates the README
  contract, which expects in-progress workflows to return their counters.
- Happy `[FAIL]` on `totalTasks == 24` on the initial read: the counter is
  computed against a filtered set (e.g. only non-`waiting` tasks).
- Sad `[FAIL]` on the error code: an unrelated route is shadowing the 404
  with its own envelope, or the constant was renamed without updating the
  route handler.
