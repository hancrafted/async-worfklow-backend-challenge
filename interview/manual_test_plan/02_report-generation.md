# §02 — ReportGenerationJob (Readme §2)

**Scripts:** `02_report-generation_happy.sh`, `02_report-generation_sad.sh`
**Backing tests:** `tests/02-report-generation/`

## What the requirement is

Readme §2 asks for a `ReportGenerationJob` that

1. aggregates the outputs of preceding tasks into a JSON report shaped like
   `{ workflowId, tasks: [...], finalReport }`,
2. runs only after all preceding tasks complete, and
3. surfaces failure information when upstream tasks fail (the report job
   itself does not run on garbage data — failure flows through the
   workflow's synthesized `finalResult` instead).

In the 24-step example DAG the requirement is exercised by **four**
`reportGeneration` tasks: three lane reports (steps 21/22/23, each fed by
its own lane's `[polygonArea, analysis]`) and the final aggregation step
24, which depends on `[21, 22, 23]`.

## Live progress view

Because the 24-step DAG is the longest-running case in the manual plan,
`02_report-generation_happy.sh` uses the `watch_workflow` helper from
`_lib.sh` to render a 1-second live progress view in interactive
terminals — every tick clears the screen and prints the per-task status
table. In a batch loop (or any non-TTY context) the same helper falls
back to silent polling, so the script remains greppable for `[PASS]` /
`[FAIL]` evidence with no screen-clearing noise.

## What the happy script proves

`02_report-generation_happy.sh` runs the full DAG and asserts:

- exactly **4** `reportGeneration` tasks reach `completed` (proves the
  per-lane reports + final aggregator all fired);
- step 24's `Result.data.workflowId` matches the workflow under test;
- step 24's `Result.data.finalReport` is a non-empty string;
- step 24's `Result.data.tasks | length` equals **3** — i.e. step 24
  aggregated exactly its three direct upstream entries (steps 21/22/23).

### Scope note on `tasks | length == 3`

This is a **shape-level** assertion: it proves "step 24 received an
aggregated list with the right cardinality from its dependsOn closure". It
deliberately does **not** assert per-lane content (which `taskId` came from
which lane, which `output` it carries). Per-lane content correctness is the
job of the unit tests in `tests/02-report-generation/`; here we assert that
the aggregation envelope is well-formed and matches the DAG's dependency
declaration. Coupling a manual-plan assertion to lane-by-lane content would
make the script fragile to YAML reshuffles for no extra signal.

## What the sad script proves

`02_report-generation_sad.sh` posts invalid GeoJSON so the lane-head
`polygonArea` tasks fail, then asserts:

- the workflow terminates as `failed`;
- **zero** `reportGeneration` tasks reach `completed` — the report job is
  not run on garbage upstream output, satisfying the "runs only after all
  preceding tasks are complete" requirement under failure;
- all **4** `reportGeneration` steps are swept to `skipped` by fail-fast;
- the failure information surfaces via `Workflow.finalResult.failedAtStep`
  rather than via a half-baked report — that is the honest interpretation
  of Readme §2's "include error information in the report" once you decide
  not to run the report job on bad inputs at all.

## What to look for in the output

- `WorkflowId: <uuid>` followed by the `--- step 24 Result.data ---` block
  on the happy path — the JSON dump shows the `{ workflowId, tasks[3],
  finalReport }` envelope so a reviewer can sanity-check it visually before
  the assertions parse it with jq.
- `dump_workflow` on the sad path showing the four `skipped`
  `reportGeneration` rows.
- One `[PASS]` per assertion; `summarize` prints the final per-script line.

## What would change if it broke

- Happy `[FAIL]` on the count of 4: a lane report (step 21/22/23) is not
  firing — likely a regression in dependency promotion when lane reports
  share `polygonArea` output across analyses.
- Happy `[FAIL]` on `tasks | length == 3` but the count of 4 is green: the
  aggregation envelope on step 24 is including/excluding the wrong upstream
  set — inspect the dependsOn resolution in `ReportGenerationJob`.
- Sad `[FAIL]` on the count of 0 completed reports: fail-fast is not
  short-circuiting downstream — see `interview/archive/manual_test_plan/03b-ii-wave-3_fail-fast-sweep-and-workflow-failed.md`.
