# §04 — `Workflow.finalResult` (Readme §4)

**Scripts:** `04_workflow-final-result_happy.sh`, `04_workflow-final-result_sad.sh`
**Backing tests:** `tests/04-workflow-final-result/`

## What the requirement is

Readme §4 asks that the aggregated results of all tasks in the workflow are
saved to a `finalResult` field on the `Workflow` entity, and that the field
also captures failure information when the workflow fails. In this codebase
the field is written **eagerly** inside the same transaction that performs
the workflow's terminal status transition (completed or failed) — see
`interview/archive/manual_test_plan/04_workflow-final-result-synthesis.md`
for the original design note.

The synthesized payload has shape:

- `workflowId` — the id of the workflow being aggregated;
- `tasks: [...]` — one entry per task in the workflow (success or failure);
- `failedAtStep` — present and numeric only if the workflow ended `failed`.

## What the happy script proves

`04_workflow-final-result_happy.sh` runs the full DAG and asserts:

- the `workflows.finalResult` SQLite column is non-null after the workflow
  reaches `completed` — this is the headline assertion: "the column got
  written, eagerly, as part of the terminal transition";
- `finalResult.workflowId` matches the workflow under test (proves it was
  written for the right row, not a cross-write from a sibling workflow in a
  concurrent run);
- `finalResult.tasks | length` equals **24** — every YAML step is
  represented in the aggregate;
- `finalResult.failedAtStep` is absent (i.e. evaluates to `null`) on the
  happy path. The framework deliberately omits the key rather than writing
  `null` so consumers can distinguish "no failure" from "we forgot to set
  the field".

## What the sad script proves

`04_workflow-final-result_sad.sh` posts invalid GeoJSON and asserts:

- the workflow reaches `failed`;
- `workflows.finalResult` is **still non-null** — the eager write fires for
  terminal=failed too, satisfying Readme §4's "include failure information
  in the final result" requirement;
- `finalResult.failedAtStep` is a number (the step that tripped the
  fail-fast sweep);
- at least one entry in `finalResult.tasks[]` carries an `error` block with
  a `message` — proving the per-task failure reason is propagated into the
  synthesized payload, not just the workflow-level marker.

## Why "eager write" matters for the test

If the column were written lazily (e.g. computed on-demand inside the
`/results` endpoint), the SQLite assertion would always pass for queried
workflows but never for unqueried ones — and a crash between terminal
transition and first read would silently lose the aggregate. The eager
write is the contract; asserting on the column directly is how we prove it.

## What to look for in the output

- The `--- finalResult (DB column) ---` dump prints the first 40 lines of
  the synthesized JSON — a visual sanity check before the jq assertions
  parse specific fields.
- On the sad path the dump also shows the `failedAtStep` field and the
  failed task's `error.{message,reason}` block.
- One `[PASS]` per assertion; `summarize` prints the per-script line.

## What would change if it broke

- Happy `[FAIL]` on "column not null": the terminal transition is not
  invoking the synthesizer, or the transaction is rolling back the eager
  write (check the post-task transaction wrapping in the runner).
- Happy `[FAIL]` on `tasks | length == 24`: the synthesizer is iterating
  over a filtered set (e.g. only `completed` rows) instead of all rows.
- Sad `[FAIL]` on `failedAtStep` being a number: the failure metadata is
  not being threaded into the synthesizer — inspect where `failedAtStep` is
  set during the fail-fast sweep.
