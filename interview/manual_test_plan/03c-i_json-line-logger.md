# §Task 3c-i — Wave 1 — JSON-line structured logger (US22)

**Branch:** `https-server-task-8`
**PRD:** §11 (Worker error handling and structured logging) / US22

This wave delivers the in-house JSON-line logger (`src/utils/logger.ts`) and
swaps the `console.log` / `console.error` call sites in `src/index.ts`,
`src/workers/taskRunner.ts`, `src/workers/taskWorker.ts`, and
`src/routes/analysisRoutes.ts` over to it. Out of scope: the worker-pool
loop, runner-level loop-of-last-resort logging, `example_workflow.yml`
edits.

## Logger contract recap

Each `info(...)` / `warn(...)` / `error(...)` call writes **exactly one**
JSON line:

```jsonc
{
  "level": "info",          // "info" | "warn" | "error"
  "ts": "2026-04-28T...Z",  // ISO-8601
  "msg": "starting job",
  "workflowId": "<uuid>",   // optional context fields are omitted when absent
  "taskId": "<uuid>",
  "stepNumber": 1,
  "taskType": "polygonArea",
  "error": { "message": "...", "stack": "..." } // ≤10 stack lines
}
```

`info` and `warn` go to stdout; `error` goes to stderr; the `level` field is
the discriminator.

## Setup

```bash
npm install   # only on a fresh clone
npm start | tee /tmp/server.log
# → {"level":"info","ts":"…","msg":"server listening at http://localhost:3000"}
```

Pipe through `jq` for pretty-printing:

```bash
npm start 2>&1 | jq -c .
```

## 1. Happy path — `starting job` + `job completed` info lines

Submit a single-step workflow (the default `example_workflow.yml`) and watch
the server log:

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-logger-happy",
    "geoJson": { "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] }
  }'
# → 202 { "workflowId": "<uuid>" }
```

Within ~5s the server log emits two info JSON lines for step 1, e.g.:

```bash
grep -E 'starting job|job completed' /tmp/server.log | jq .
# → { "level": "info", "msg": "starting job",   "taskId": "<uuid>", "stepNumber": 1, "taskType": "polygonArea", … }
# → { "level": "info", "msg": "job completed",  "taskId": "<uuid>", "stepNumber": 1, "taskType": "polygonArea", … }
```

Confirm:
- both lines parse as JSON (no embedded newlines, no string concatenation
  of `console.log` argument lists)
- both carry `workflowId`, `taskId`, `stepNumber`, `taskType`
- `ts` is a parseable ISO-8601 string

## 2. Error path — `job failed` error line on stderr

Submit a payload that PolygonAreaJob rejects (a `Point`, not a `Polygon`):

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-logger-failure",
    "geoJson": { "type": "Point", "coordinates": [0,0] }
  }'
# → 202 { "workflowId": "<uuid>" }
```

After the next worker tick (~5s), stderr emits one error JSON line:

```bash
grep '"job failed"' /tmp/server.log | jq .
# → {
#     "level": "error",
#     "msg": "job failed",
#     "workflowId": "<uuid>",
#     "taskId": "<uuid>",
#     "stepNumber": 1,
#     "taskType": "polygonArea",
#     "error": {
#       "message": "Invalid GeoJSON (Polygon expected): NOT_A_POLYGON",
#       "stack": "Error: Invalid GeoJSON ...\n    at PolygonAreaJob.run (...)\n  ..."  // ≤10 lines
#     }
#   }
```

Confirm:
- the error line is on stderr (`npm start 2>/dev/null` hides it; `2>&1` keeps it)
- `error.stack` has at most 10 newline-separated entries (the truncation
  matches `serializeJobError`)
- the legacy free-form `Error running job ...` line is **gone**

## 3. Automated coverage

The contract is locked by two test files; both run as part of `npm test`:

```bash
npx vitest run src/utils/logger.unit.test.ts
# → 5 tests passed (happy + error path)

npx vitest run tests/03-interdependent-tasks/tasks-can-be-chained-through-dependencies.test.ts \
  -t "R3 — runner: structured JSON-line logging"
# → 2 tests passed (happy + error path through tickOnce)
```

## Observed results (2026-04-28, automated run)

| Check | Result |
| --- | --- |
| `npm test` | 18 files / 85 tests passed (was 83) |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
