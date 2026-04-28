# §Pre-#7 — Worker infrastructure prelude

**Branch:** `frozen-bass`
**PRD:** §Implementation Decisions 9, 10
**Spec:** [Pre-#7 worker infrastructure (A1 + A2 + A4)](intent://local/task/56508807-7ef0-4b70-b28c-48b26e122086)

This task lays the structural seams (`tickOnce`, atomic-claim primitive,
`Task.workflowId` join column) that Issue #7 will hook into. There are no
user-visible behavior changes — the worker still runs one queued task per
5s tick. The verification below proves the seams exist and the schema
rename landed.

## Setup

```bash
npm install   # only on a fresh clone
```

## 1. Schema — `Task.workflowId` is a real column

Boot the server (the live worker isn't needed for this check; the schema is
created during `AppDataSource.initialize`):

```bash
npm start   # leave it running long enough for "Server is running…" to print, then Ctrl-C
```

Inspect the SQLite schema:

```bash
sqlite3 data/database.sqlite ".schema tasks" | tr ',' '\n'
```

**Expected:** the output contains a `workflowId` column and **does not**
contain `workflowWorkflowId`. Example excerpt:

```
"workflowId" varchar NOT NULL
CONSTRAINT "FK_…" FOREIGN KEY ("workflowId") REFERENCES "workflows" ("workflowId")
```

## 2. Live worker still drives a workflow end-to-end

The shipped `src/workflows/example_workflow.yml` (single `analysis` step)
is the right fixture; do not edit it.

```bash
npm start
# → Server is running at http://localhost:3000
```

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-pre-7",
    "geoJson": { "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] }
  }'
# → 202 { "workflowId": "<uuid>", ... }
```

Wait ~5s, then:

```bash
sqlite3 data/database.sqlite \
  "SELECT taskType, status, workflowId FROM tasks WHERE clientId='manual-pre-7';"
# → analysis | completed | <same uuid as the response>
```

The `workflowId` column is populated and matches the workflow returned by
the API — proves both the schema rename and the relation are wired
correctly (DOD: `task.workflowId === task.workflow.workflowId`).

## 3. Atomic-claim primitive — covered by automated tests

The race semantics are exercised by `src/workers/taskWorker.test.ts`
("under concurrent ticks against one queued task, exactly one wins"). Run
just that file to verify locally:

```bash
npx vitest run src/workers/taskWorker.test.ts
# → 3 passed (returns true after running, returns false on empty queue,
#            atomic claim under simulated race)
```

A manual two-process race against the SQLite file is intentionally not
documented here — the in-process unit test is the canonical verification
for PRD §10 in this scope (single-process worker today, race-safe primitive
for the worker pool tomorrow per `interview/no-lease-and-heartbeat.md`).

## 4. Cleanup

`AppDataSource` boots with `dropSchema: true`, so every restart wipes the
DB. Nothing to revert.
