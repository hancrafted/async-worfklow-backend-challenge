# §Pre-#7 — Shared test helpers

**Branch:** `frozen-bass`
**Spec:** `intent://local/note/spec` — Pre-#7 hardenings (A5)
**Wave:** 3 of 3 (after A1+A2+A4 worker infra and D1+D5 CLAUDE.md)

## What this task adds

Three reusable Vitest helpers under `tests/03-interdependent-tasks/helpers/`
for #7's upcoming integration tests:

- `drainWorker(repository, { maxTicks? })` — manual synchronous drain over
  `tickOnce(...)`; returns the number of tasks executed; throws
  `drainWorker exceeded maxTicks (=N)` once the cap is exceeded (default 50).
- `seedWorkflow(dataSource, fixtureFileName, { clientId?, geoJson? })` —
  thin wrapper over `WorkflowFactory.createWorkflowFromYAML(...)` for files
  in `tests/03-interdependent-tasks/fixtures/`; returns
  `{ workflow, tasks }`.
- `mockJobsByType.ts` exports `setMockJobsByType(jobsByType)` and
  `jobFactoryMockImpl()` — wires `vi.mock("../../../src/jobs/JobFactory")`
  to a `Record<taskType, Job>` registry; throws if a test asks for a
  `taskType` that isn't registered.

Smoke coverage lives in
`tests/03-interdependent-tasks/helpers/helpers.unit.test.ts`: it seeds the
existing `three-step-mixed-deps.yml` fixture, mocks the deps-free step's
job, drains, and asserts `ranCount === 1` plus the expected
completed/waiting status mix. The error describe covers `drainWorker`'s
`maxTicks` overflow and `mockJobsByType`'s missing-type throw.

## How to verify locally

```bash
# All three helpers exist and the smoke test passes
npx vitest run tests/03-interdependent-tasks/helpers/helpers.unit.test.ts
# → 3 passed (1 happy path + 2 error paths)

# Full repo green
npm test         # → 57 passed
npm run lint     # → 0 errors
npm run typecheck
```

The helpers are intentionally **not** used in production code or in
existing #7 test files (#7 itself will adopt them).

## Cleanup

Helpers are pure test-only modules; nothing to revert beyond `git revert`
of the commit if needed.
