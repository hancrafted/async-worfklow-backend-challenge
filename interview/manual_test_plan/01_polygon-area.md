# §01 — PolygonAreaJob (Readme §1)

**Scripts:** `01_polygon-area_happy.sh`, `01_polygon-area_sad.sh`
**Backing tests:** `tests/01-polygon-area/`

## What the requirement is

Readme §1 asks for a `PolygonAreaJob` that

1. computes a polygon area in square meters from the task's `geoJson`, and
2. fails the task gracefully on invalid GeoJSON (no silent corruption).

The `output` of the job (in this codebase: `Result.data`) carries the
calculated value. A descriptive failure surfaces via `Result.error` on the
sad path so the failure reason is auditable post-hoc.

## What the happy script proves

`01_polygon-area_happy.sh` posts a valid Polygon to `POST /analysis` and
waits for the workflow to terminate. The example DAG has three lane heads of
`taskType=polygonArea` (steps 2, 3, 4 — see `src/workflows/example_workflow.yml`),
so the happy path asserts:

- the workflow reaches `completed` (proves all three lane heads ran), and
- exactly **3** `polygonArea` tasks finished with `status='completed'`, each
  carrying a positive numeric `areaSqMeters` in `Result.data`.

Asserting "positive numeric" rather than a literal value keeps the test
robust against `@turf/area` minor-version drift while still proving the
job ran the real geodesic calculation rather than persisting a placeholder.

## What the sad script proves

`01_polygon-area_sad.sh` posts a non-Polygon geometry (a Point) and asserts:

- the workflow terminates as `failed` (the lane heads cannot succeed);
- at least one `polygonArea` task is in `status='failed'` — sibling lane
  heads may legitimately end up `skipped` once fail-fast sweeps the DAG, so
  the assertion is "≥1 failed" rather than "all three failed";
- the failed task's `Result.error` mentions `"Invalid GeoJSON"`, proving the
  human-readable reason was persisted (not just the task status flipped).

## Why these assertions and not others

We deliberately do not pin the numeric area value. `@turf/area` is a
third-party dependency; pinning a literal would make the test brittle to
upstream patch releases without proving anything new. The "> 0" assertion
proves the calculation ran on the real geometry.

We deliberately allow ≥1 failed (rather than =3 failed) on the sad path
because the workflow runner's fail-fast sweep is allowed to short-circuit
sibling lane heads to `skipped`. That sweep behaviour is itself covered by
the §02 sad script and the `tests/03b-ii-wave-3-fail-fast-sweep/` integration
suite; pinning =3 here would couple §01 to a behaviour that belongs elsewhere.

## What to look for in the output

- The `WorkflowId: <uuid>` line — every assertion below it filters on that
  id, so the run is hermetic against other workflows in the DB.
- The `dump_workflow` table — a quick visual confirmation that steps 2/3/4
  are `polygonArea` and reached the expected terminal state.
- One `[PASS]` line per assertion; final `[PASS] §01 happy path` /
  `[PASS] §01 sad path` from `summarize`. Any `[FAIL]` halts the script
  with a non-zero exit code.

## What would change if it broke

- All three `[PASS]` lines green but the workflow is `failed`: the
  PolygonAreaJob is throwing on a valid Polygon — likely a `@turf/area`
  upgrade contract change or a JSON-shape regression in `Result.data`.
- Happy `[PASS]` but sad `[FAIL]` on the `Result.error` assertion: the job
  is silently swallowing the error or persisting it under a different key.
  See `interview/archive/no-task-output-column.md` for why error detail
  lives on `Result`, not on `Task`.
