# §03a — Workflow YAML `dependsOn` (Readme §3)

**Scripts:** `03a_workflow-yaml-dependson_happy.sh`
**Backing tests:** `tests/03a-workflow-yaml-dependson/` (sad-path coverage)

## What the requirement is

Readme §3 asks the workflow system to support tasks that depend on the
outputs of earlier tasks. In this codebase the requirement decomposes into:

1. the YAML format declares dependencies via `dependsOn: [stepNumber, ...]`;
2. `WorkflowFactory` parses those arrays and persists them on the `Task`
   rows;
3. the runner waits for declared dependencies before promoting a task from
   `waiting` to `queued`;
4. the persisted `dependsOn` is observable via `GET /workflow/:id/status`
   so an external client can audit the DAG it is running.

## Why §03a has only a happy script

§03a covers **YAML parsing + persistence + API surface** of `dependsOn`.
Error paths for malformed YAML (cyclic graphs, unknown step numbers,
non-array values) are deterministic and parser-local — exercised
exhaustively under `tests/03a-workflow-yaml-dependson/` without needing a
live server. A sad-path shell script would duplicate that coverage or
require shipping intentionally-broken YAML into `src/workflows/`.

The locked PRD records this in §Shell-script contract (Round-10 Q3): "§03a
ships only `_happy.sh`. Sad-path coverage lives in
`tests/03a-workflow-yaml-dependson/`." The verification table in
`/interview.md` shows `—` for §03a sad with a footnote pointing at the
tests folder.

## What the happy script proves

`03a_workflow-yaml-dependson_happy.sh` posts the example workflow and:

- waits for the workflow to reach `completed` — this proves the **runtime**
  side of dependsOn: the runner respected the topological order across the
  full 24-step DAG (otherwise lanes 5/6/7 would have started before their
  upstream `polygonArea` finished, and step 24 would have aggregated empty
  reports);
- spot-checks three representative dependency edges via `GET /status`'s
  `tasks[]` array:
  - step **5** dependsOn `[2]` (a 1→1 lane edge),
  - step **17** dependsOn `[14, 15, 16]` (the lane-convergence node), and
  - step **24** dependsOn `[21, 22, 23]` (the final aggregator).

The combination "completed end-to-end + API echoes the YAML correctly"
proves both the parser (YAML → entities) and the surface (entities → JSON)
are wired through.

## Why these three edges and not all 24

A 24-row spot check would mostly be noise. The three picked are the
**load-bearing** edges in the DAG topology:

- step 5 — single-parent linear edge,
- step 17 — multi-parent join (3 parents, order-sensitive), and
- step 24 — report aggregator's parent set.

Any parser regression that flips order, drops parents, or mishandles
multi-parent edges surfaces in at least one of these three. Per-edge
exhaustive coverage lives in the tests folder.

## What to look for in the output

- The `--- /status tasks (dependsOn arrays) ---` dump shows every task's
  `{stepNumber, dependsOn}` pair — a quick visual cross-check against
  `src/workflows/example_workflow.yml`.
- One `[PASS]` line per spot-check; `summarize` prints `[PASS] §03a happy
  path`.

## What would change if it broke

- Workflow stuck below terminal: the runner is not promoting tasks once
  their parents complete — likely a regression in the readiness check.
- Workflow completes but a spot-check fails: the API is dropping or
  reordering `dependsOn` — inspect the `/status` route's serializer or the
  `Task` entity column type.
