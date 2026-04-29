# study.md — Osapiens interview prep (7 days × 2h, descending priority)

> Audience: Han, prepping a fullstack-backend-leaning team-lead interview at osapiens (compliance-tech SaaS; performance, distributed architecture, security, compliance).Budget: ~14 hours total. Sections are sized in minutes; do §1 → §8 in order. §8 is always last.Source of truth for code references: this repository. The defense notes in interview/ are the long-form rationale for the most-grilled decisions.

## How to use this guide (READ FIRST — agent + user, every session)

**For the user.** This guide is a Socratic study session. Each subsection follows the same rhythm: short concept → pause for your questions → short quiz → application question → links to where the concept lives in the repo. Tell the agent how long you have today; it will pick up where you left off (see Progress Log) and stop at the next clean section boundary.

**For the AI agent driving a session.** Hard contract:

1. **Resume rule.** Open this file. Read the entire `## Progress Log` block. Find the *first* subsection whose checkbox is `- [ ]` (or whose marker is `<!-- status: in-progress -->`). Resume there. Confirm with the user in one sentence: *"Resuming at §X.Y — <title>. You have <minutes> today. OK?"*
2. **Per-subsection script.** For each subsection:a. Read **Concept** aloud (or summarize, if the user prefers). Keep it tight — ≤3 minutes.b. Show **Maps to your code** so the user can navigate to the actual files.c. Prompt verbatim: *"Any questions on §X.Y before the quiz? Reply 'quiz me' to proceed."*d. After the user replies `quiz me`, ask the **Recall quiz** questions one at a time. Do **not** reveal the answer key until the user has answered (or said "skip"). Then show the expected answer and a one-line gap note if their answer was incomplete.e. Ask the **Application question**. The user answers free-form. Grade it: *what was strong, what was missing, one sharper reframing*. No score number — feedback only.f. Mark the subsection checkbox `- [x]`. If recall < 3/3 OR application was weak, also append a flag in the Progress Log entry (`revisit: §X.Y — <reason>`).
3. **Progress Log.** At the **end** of every session, append exactly one new entry at the bottom of the log (do not edit prior entries). Format:`- YYYY-MM-DD — covered §X.Y..§X.Z (Nm). Recall N/N total. Revisit: <list or "none">. Notes: <one line>.`
4. **Stop rules.** Stop at the next subsection boundary when the user's stated minutes are exhausted, or when the user says "stop". Never start a new subsection with <8 minutes left.
5. **Code references.** When pointing at code, use the form `<file>::<symbol>` (e.g. `src/workers/taskWorker.ts::run`). Do not paste code excerpts inline unless the user asks — the user has the repo open.
6. **§8 (Mock rehearsal + gap fix) must be the last session.** If the user tries to start §8 before §1–§7 checkboxes are all `- [x]`, ask them to confirm they want to skip ahead and log it.

**Quiz answer policy.** Recall questions have an `<details><summary>Answer key</summary>...</details>` block. The agent must not reveal it before the user attempts the answer. Application questions have **no** answer key — they're judgment questions; the agent provides feedback against the rubric in the question itself.

## Progress Log

- 2026-04-29 — covered §1.1 (30m). Recall 2/3. Revisit: §1.1 — N+1 connection count and the "axes-of-change vs. substrate-swap" framing on the 1000× redesign; rehearse the 90-second original whiteboard before any redesign drill. Notes: keep/replace/don't-know shape was right; sketch of the current system was skipped and the redesign jumped to Postgres+Docker without naming the topology axes (claim substrate, worker-fleet management, result storage).

## Top-level checklist (jump to any block)

- [ ] §1 Own your challenge code cold (~3h)
- [ ] §2 PostgreSQL concurrency for queues (~1.5h)
- [ ] §3 Distributed-systems vocabulary mapped to your MES (~2.5h)
- [ ] §4 Node concurrency model (~1h)
- [ ] §5 Multi-tenant SaaS security (~2h)
- [ ] §6 Compliance domain for osapiens (~1h)
- [ ] §7 STAR stories polished (~1.5h)
- [ ] §8 Mock rehearsal + gap fix (~1.5h, do **last**)

## §1 Own your challenge code cold (~3h)

**Section objective.** Defend every design decision in this repository from first principles, in your own words, without saying "the AI did it." This is the single highest-leverage prep block — the interviewer will absolutely deep-dive your code.

### §1.1 The architecture in one breath (~30m)

**Objective.** Be able to whiteboard the system in 90 seconds: HTTP → DB → worker pool → DB → HTTP.

**Concept.** The system is a **single-process Node app** with three concurrent surfaces sharing one SQLite database:

1. **Express HTTP API** (`src/index.ts`, `src/routes/*`) — accepts `POST /analysis` (creates a workflow + tasks, returns a workflow id), serves `GET /workflow/:id/status` and `GET /workflow/:id/results`.
2. **Workflow factory** (`src/workflows/WorkflowFactory.ts`) — parses the YAML DAG, validates `dependsOn` (`src/workflows/dependencyValidator.ts`), inserts a `Workflow` row + N `Task` rows in **one transaction**, with the public `stepNumber` separate from the internal UUIDs.
3. **Worker pool** (`src/workers/taskWorker.ts`, `src/workers/taskRunner.ts`) — N coroutines (default 3) on the Node event loop. Each worker has its **own TypeORM **`DataSource` (own SQLite connection in WAL mode — see §1.4). Each tick: claim one ready task with optimistic lock + version bump, dispatch to the right `Job` via `JobFactory`, write a `Result` row + transition the task in **one transaction**, run promotion/sweep in the same transaction, sleep 5s, repeat.
4. **Final result synthesis** (`src/workflows/synthesizeFinalResult.ts`) — invoked when the workflow reaches a terminal state; output stored on `Result`, **not** on `Task` (defense: `interview/no-task-output-column.md`).

**Key invariants.** (a) `Task.status` transitions only inside a transaction that also writes the `Result`. (b) Promotion of dependents happens in the *same* transaction as the terminal write. (c) `stepNumber` is the public identifier; UUIDs never leak. (d) On failure, the rest of the workflow is **fail-fast swept** — in-progress siblings run to completion, no cancellation interface, no new tasks promoted.

**Maps to your code.**

- `src/index.ts` (boot wiring), `src/routes/workflowRoutes.ts`, `src/routes/analysisRoutes.ts`
- `src/workflows/WorkflowFactory.ts` (single-pass insert), `src/workflows/dependencyValidator.ts`
- `src/workers/taskWorker.ts` (the loop), `src/workers/taskRunner.ts` (per-task transaction)
- `src/data-source.ts` (the per-worker DataSource factory)
- `src/models/{Workflow,Task,Result}.ts`
- Defense: `interview/design_decisions.md` (top-of-file general assumptions)

**Pause for questions.** *Any questions on §1.1 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. How many DB connections does the running system hold by default, and why that number?
2. In what transactional unit is a task's terminal write + promotion of its dependents committed?
3. What is the public identifier for a task, and why isn't it the UUID?

<details><summary>Answer key</summary>

1. **N+1** by default — N=3 worker DataSources (one SQLite connection each, WAL mode, see §1.4) plus 1 connection for HTTP/factory work. The reason is that SQLite serializes writes per connection; per-worker connections let `BEGIN`/`COMMIT` boundaries not stomp each other.
2. **One transaction per task tick** in `taskRunner` — that single transaction writes the `Result`, transitions the `Task` to terminal, *and* runs promotion of newly-ready dependents (or fail-fast sweep on failure). Spelled out in CLAUDE.md "Transactions" rule.
3. `stepNumber` (1-based, defined in the YAML). UUIDs are internal; the spec/Readme talks about steps and dependencies in step numbers, and the public API surfaces step numbers in `/results`. Keeps internal identifiers replaceable.</details>

**Application question (open, AI grades).** Whiteboard this system on a blank page in 90 seconds. Then redraw it as you'd run it at **1000× scale** (1000 workflows/s, 100k workers across a fleet). Name *one* thing you'd keep, *one* thing you'd replace, and *one* thing you don't yet know how you'd solve. (Rubric: clarity of original, honesty of "don't yet know", soundness of the replacement choice.)

- [x] §1.1 complete

### §1.2 Lifecycle, promotion, and fail-fast sweep (~45m)

**Objective.** Defend the task-state machine and explain why promotion + sweep live inside the terminal-write transaction.

**Concept.** Task states: `queued → in_progress → completed | failed`. A worker tick claims a `queued` task whose `dependsOn` are all `completed` (the readiness check in `taskRunner`). On `completed`, the same transaction promotes any dependents whose remaining dependencies are now satisfied — they flip from a holding state to `queued`. On `failed`, the same transaction runs a **sweep**: every not-yet-started descendant is marked `failed` (or skipped), and the workflow itself transitions to `failed` if no in-progress siblings remain. In-progress siblings are **not** cancelled — there is no cancellation interface; they run to completion (success or failure) and the workflow's terminal state is decided when the last one settles. This is **fail-fast in the CI-pipeline sense**: stop scheduling new work, let in-flight work drain.

**Why one transaction.** If the terminal write committed and *then* promotion ran in a second transaction, a crash between them would leave the system with a completed task whose dependents were never promoted — a permanent stall, invisible to the workflow. The CLAUDE.md "Transactions" rule encodes this: any sequence of writes that mutates more than one row must be wrapped in `dataSource.transaction(...)`.

**Maps to your code.**

- `src/workers/taskRunner.ts` (per-task transaction; promotion + sweep)
- `src/models/Task.ts` (status enum, version column for optimistic claim)
- `interview/design_decisions.md` §Task 7 + §Issue #17 — the journey
- Defense: `interview/no-lease-and-heartbeat.md` (why no recovery sweep on boot)

**Pause for questions.** *Any questions on §1.2 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. Why must promotion of dependents run in the *same* transaction as the terminal task write?
2. On a task `failed`, what happens to its sibling tasks that are currently `in_progress`?
3. What's the difference between *fail-fast in the CI-pipeline sense* and *cancellation*?

<details><summary>Answer key</summary>

1. Crash safety. Two transactions can interleave a crash between them, leaving completed tasks whose dependents are never promoted — a silent stall. Single-transaction promotion is atomic w.r.t. crashes.
2. **Nothing is cancelled.** They run to completion. The workflow's terminal state is decided when the last in-flight task settles. There is no cancellation interface in this system — adding one is a production-grade alternative.
3. *Fail-fast (CI sense)* = stop *scheduling* new work the moment a failure is observed; let in-flight work drain. *Cancellation* = actively interrupt running work. This system does the first, not the second.</details>

**Application question.** A reviewer says: *"What if a long-running task is in_progress when one of its siblings fails — isn't the user waiting forever for a workflow they know is doomed?"* Write the 60-second answer you'd give. (Rubric: name the trade-off honestly, point at `/status` as the user's real-time signal, name when you'd add cancellation in production.)

- [ ] §1.2 complete

### §1.3 No lease, no heartbeat — the four-layer defense (~30m)

**Objective.** Defend the absence of a lease/heartbeat mechanism without flinching, and know exactly when you'd add one.

**Concept.** A traditional worker pool puts a *lease* on a claimed row (timestamp + worker id) and refreshes it via a *heartbeat*; if the lease expires, a recovery sweep returns the row to `queued`. This system has none of that. The defense is four layers:

1. **Single-process scope.** All workers share the same Node process; if the process dies, *every* worker dies; in-progress rows never need to be reclaimed by another process.
2. **Fresh DB on boot.** `synchronize: true` against a file reset on boot. Stale `in_progress` rows from a previous run are not a problem because there *is* no previous run.
3. **Optimistic claim with version bump** in the claim transaction prevents two coroutines from grabbing the same row inside one process.
4. **Per-job timeout** is the right answer to a hung job — bound the work, not the row. (Not yet implemented; documented as the production-grade addition.)

**When you'd add a lease.** Multi-process scaling, persistent DB across restarts, jobs whose runtime is unbounded and unbounded-able. Then you also need: heartbeat thread, lease-expiry recovery sweep, fencing tokens to prevent zombie writes from a worker that thinks it still owns the lease.

**Maps to your code.**

- `src/workers/taskWorker.ts` (claim path)
- Defense: `interview/no-lease-and-heartbeat.md` (full four-layer rebuttal)
- `src/data-source.ts` (`synchronize: true`, fresh-DB-on-boot)

**Pause for questions.** *Any questions on §1.3 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. Name the four layers of the "no lease" defense.
2. What is a fencing token, and why is it needed once you add leases?
3. What's the *right* mitigation for a hung job — a tighter lease, or something else?

<details><summary>Answer key</summary>

1. Single-process scope; fresh DB on boot; optimistic claim with version bump; per-job timeout (planned).
2. A monotonically increasing token issued with the lease. Storage rejects writes that carry an *older* token than the latest seen, preventing a stale worker (network-partitioned, GC-paused, etc.) from corrupting state after a new worker has taken over the lease.
3. **A per-job timeout.** A lease bounds *row ownership*, not *work duration*; a slow job with a healthy heartbeat keeps the lease forever. Bounding the work is the correct invariant.</details>

**Application question.** Interviewer: *"Walk me through what could go wrong if I deployed this system as-is to production behind two load-balanced Node containers."* Identify three concrete failure modes and the order you'd fix them in. (Rubric: per-process worker pools claiming the same task; no cross-process advisory lock; fresh-DB-on-boot becomes destructive; rank by blast radius.)

- [ ] §1.3 complete

### §1.4 Per-worker DataSources + WAL — the Issue #17 journey (~30m)

**Objective.** Tell the *iterative hardening* story: shipped pragmatic ceiling → identified substrate issue → fixed it → restored production default. This is the single best "I think like a senior" anecdote in the repo.

**Concept.** First cut shared a single SQLite connection across all workers. Concurrent `BEGIN`/`SAVEPOINT`/`COMMIT` boundaries on one connection corrupted transaction state, so the pool default was pinned to **1**. Issue #17 fixed the substrate: each worker now owns its own `DataSource` (one SQLite connection, **WAL mode**), and the default went back to **3**. Why WAL: it lets readers proceed concurrently with one writer; in rollback-journal mode, a single writer blocks all readers. The tradeoff: WAL writes a `-wal` and `-shm` sidecar file; checkpointing must be configured for long-running databases (not a concern here because of fresh-DB-on-boot).

**The talking point is the journey**, not the choice. *"I shipped a pragmatic ceiling at default=1 to unblock the rest of the work, opened an issue describing the substrate problem, fixed it as Issue #17, restored the production default. That's how I think about technical debt — name it, ship around it, pay it down."*

**Maps to your code.**

- `src/data-source.ts` (per-worker DataSource factory; WAL pragma)
- `src/workers/taskWorker.ts` (each worker constructs its own DataSource)
- Defense: `interview/design_decisions.md` §Issue #17

**Pause for questions.** *Any questions on §1.4 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. What goes wrong when N workers share one SQLite connection?
2. What does WAL mode buy you in this system, and what does it cost?
3. What's the senior-framing of the default=1 → default=3 journey?

<details><summary>Answer key</summary>

1. Concurrent transactions corrupt each other — one worker's `BEGIN` becomes another's `SAVEPOINT`; commit/rollback boundaries get confused. Effectively, transactional isolation across workers is lost.
2. **Buys:** readers don't block writers; one writer doesn't block readers (concurrent reads + a single writer). **Costs:** sidecar `-wal`/`-shm` files; periodic checkpointing needed in long-lived DBs (irrelevant here).
3. *Iterative hardening.* Ship a safe ceiling, name the technical debt explicitly, fix the substrate in a follow-up, restore the production default. Demonstrates ability to ship under uncertainty without burying problems.</details>

**Application question.** Interviewer: *"Why didn't you just use Postgres from the start?"* Answer in 60 seconds. (Rubric: scope discipline — challenge brief implied SQLite; switching the substrate is a bigger change than fixing the connection model; the per-worker DataSource pattern *carries over* to Postgres unchanged.)

- [ ] §1.4 complete

### §1.5 Output on `Result`, eager `finalResult` + lazy patch, `stepNumber` as public id (~30m)

**Objective.** Defend three small but interconnected design choices that *will* be questioned.

**Concept.** Three decisions:

1. **Output stored on **`Result`**, not on **`Task`**.** The `Task` row carries lifecycle state (status, version, dependsOn, taskType, stepNumber); the `Result` row carries the produced data. Reasons: (a) separation of concerns — lifecycle vs. payload have different mutation cardinalities (a task transitions a few times; a result is written once); (b) different retention/eviction policies in production (purge old payloads, keep audit-light task rows); (c) `Result` can grow large (GeoJSON, reports) without bloating the hot lifecycle table. Defense: `interview/no-task-output-column.md`.
2. `finalResult`** written eagerly + lazy-patched on read.** When a workflow reaches a terminal state inside the task transaction, `synthesizeFinalResult` runs and writes `finalResult` *in the same transaction*. The `/results` GET handler also recomputes/patches if a workflow is terminal but `finalResult` is missing (defensive against historical rows or edge cases). Reasons: terminal-state writers see consistent input; readers never block on synthesis; lazy patch covers the upgrade path.
3. `stepNumber`** is the public identifier.** YAML steps are 1-based ordinals; the API response surfaces them; UUIDs are internal. Reasons: stable across UUID regeneration; readable in error messages; matches the Readme's vocabulary; lets you swap UUID generation strategy without breaking clients.

**Maps to your code.**

- `src/models/Result.ts`, `src/models/Task.ts` (the split)
- `src/workflows/synthesizeFinalResult.ts` (eager write + lazy patch entry points)
- `src/routes/workflowRoutes.ts` (lazy patch on read; `/status` and `/results`)
- Defense: `interview/no-task-output-column.md`
- Per-task rationale: `interview/manual_test_plan/04_workflow-final-result-synthesis.md`

**Pause for questions.** *Any questions on §1.5 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. Why is the produced data on `Result` instead of a column on `Task`?
2. Why is `finalResult` written eagerly *and* lazy-patched on read?
3. Why is `stepNumber` (not UUID) the public identifier?

<details><summary>Answer key</summary>

1. Different mutation cardinalities (lifecycle mutates often, payload once); different retention policies (payloads purgeable, lifecycle audit-light); payloads can be large (GeoJSON/reports) and shouldn't bloat the hot lifecycle table.
2. **Eager** = writers in the terminal-write transaction see consistent input and pay the synthesis cost once. **Lazy patch** = readers never block on synthesis; defensive for historical rows / partial upgrades / future schema changes.
3. Stable across UUID regeneration; human-readable in errors; matches the Readme's domain vocabulary; lets you change UUID strategy without breaking clients.</details>

**Application question.** Interviewer: *"This sounds like over-engineering. Why not just put the JSON output on a column on *`Task`* and skip the *`Result`* table entirely?"* Defend the split in 60 seconds, then name the *one* condition under which you'd merge the two tables. (Rubric: name retention/cardinality clearly; admit the merge is reasonable for tiny payloads + short retention; don't be dogmatic.)

- [ ] §1.5 complete

### §1.6 The 1000× scale redesign drill (~15m)

**Objective.** Practice the most likely system-design follow-up so it's reflexive.

**Concept.** Take the current system. Now: 1000 workflows/sec sustained, 100k workers across hundreds of containers, multi-region, durable evidence retention (relevant to compliance), 99.95% availability. Walk it.

**The structured answer template.** Always answer in this order, even if the interviewer interrupts:

1. **Reframe the requirements** in your own words. Confirm SLOs (latency, throughput, durability, availability).
2. **Identify the 2–3 axes that change first.** For this system: claim contention (single-DB queue → distributed queue), result storage (single SQLite → object store + metadata DB), worker fleet management (per-process pool → orchestrator like K8s/Nomad).
3. **Pick concrete components and name the trade-offs.** "I'd put a Postgres-backed queue with `SELECT … FOR UPDATE SKIP LOCKED` for ≤1k claims/sec; above that, switch to Kafka with consumer groups for ordering guarantees per workflow." Name what each choice *costs*.
4. **Failure modes.** What breaks first under 10× the proposed scale? Hot partitions? Backpressure? GC pauses?
5. **What I don't know.** Be honest. "I haven't run a Kafka cluster at multi-region; I'd partner with platform engineering on consumer group rebalance behavior."

**Maps to your code.** This is the bridge to §3 (distributed vocabulary) and §4 (Node concurrency). Reference `src/workers/taskWorker.ts` as "the part that becomes a Kafka consumer" and `src/workflows/WorkflowFactory.ts` as "the part that becomes the saga orchestrator."

**Pause for questions.** *Any questions on §1.6 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. What's the fixed order you answer a "scale this 1000×" question in?
2. At what claim rate would you stop using `SKIP LOCKED` on Postgres and move to a dedicated broker? Name the broker and one reason.
3. Name two things that break first under 10× more scale than your proposed redesign.

<details><summary>Answer key</summary>

1. Reframe → axes of change → concrete components + trade-offs → failure modes → what I don't know.
2. Roughly **1k–10k claims/sec sustained**, depending on row width and isolation level. Move to Kafka (durable ordered log, consumer groups), Redis Streams (lower op cost, weaker durability), or RabbitMQ (rich routing, weaker throughput). One reason for Kafka: consumer groups give you partition-level ordering + horizontal scale + replayability for compliance.
3. Examples: hot partitions (uneven workflow id distribution); consumer rebalance storms; backpressure into the producer; result store throughput / object-store small-file penalty; GC pauses on large in-flight task batches.</details>

**Application question.** Pick a sheet of paper. Set a 5-minute timer. Whiteboard the 1000× redesign for this system out loud, following the structured template. Then ask the agent to grade against the rubric. (Rubric: did you reframe before designing? did you name trade-offs *for each* component? did you admit one unknown?)

- [ ] §1.6 complete

## §2 PostgreSQL concurrency for queues (~1.5h)

**Section objective.** Speak Postgres-as-queue fluently — the single most common backend interview deep-dive when worker pools come up. Maps directly to "what would you change to make this work on Postgres?"

### §2.1 `SELECT … FOR UPDATE SKIP LOCKED` (~30m)

**Objective.** Explain the canonical Postgres queue pattern, why it works, and where it breaks.

**Concept.** The canonical "Postgres as a queue" pattern is:

```sql
BEGIN;
SELECT id FROM tasks
  WHERE status = 'queued' AND ready = true
  ORDER BY priority, created_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED;     -- skip rows other workers hold a lock on
UPDATE tasks SET status = 'in_progress', worker_id = $1, claimed_at = now()
  WHERE id = $picked;
COMMIT;
```

**Why it works.** `FOR UPDATE` takes a row-level lock for the duration of the transaction. `SKIP LOCKED` tells Postgres: if another transaction already holds the lock on a candidate row, skip it and try the next one — *don't wait, don't fail*. Two workers running this query concurrently will pick **different** rows. No advisory lock, no application-level coordination needed.

**Why it can break.** (a) Without an index on `(status, ready, priority, created_at)`, the planner does a sequential scan and lock acquisition becomes a serializing bottleneck. (b) Long-running transactions hold the lock the whole time — keep the claim transaction short; do the *work* outside it; come back for the terminal write in a second short transaction. (c) Past ~10k claims/sec, the per-row lock overhead and WAL pressure exceed what Postgres comfortably serves; switch to a dedicated broker. (d) Visibility map and HOT updates matter — heavy claim churn on the same partition can amplify autovacuum work.

**Maps to your code.** Your `src/workers/taskWorker.ts` claim path is the moral equivalent on SQLite (with optimistic version bump instead of `SKIP LOCKED`). On Postgres, you'd replace the optimistic claim with `FOR UPDATE SKIP LOCKED`. Everything else (per-worker DataSource, single-transaction terminal write + promotion) carries over.

**Pause for questions.** *Any questions on §2.1 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. What does `SKIP LOCKED` do that plain `FOR UPDATE` does not?
2. Why must the claim transaction be short, and what happens if it isn't?
3. Above roughly what claim rate does the Postgres-as-queue pattern stop being a good fit?

<details><summary>Answer key</summary>

1. Plain `FOR UPDATE` *waits* on a row-level lock held by another transaction (or fails on `NOWAIT`). `SKIP LOCKED` skips that row entirely and considers the next candidate, so concurrent workers pick disjoint rows without blocking.
2. Because the row-level lock is held until commit. A long claim transaction means the row stays locked, blocking other observers (e.g. status queries that take the same lock), increasing contention, and growing the lock table. Pattern: short claim TX → do work outside the TX → short terminal-write TX.
3. **~10k claims/sec sustained** as a rule of thumb (highly schema- and hardware-dependent). Past that, per-row lock overhead, WAL throughput, and autovacuum pressure dominate; move to Kafka / Redis Streams / RabbitMQ.</details>

**Application question.** Sketch the index you'd put on the `tasks` table to make `SELECT … FOR UPDATE SKIP LOCKED` fast. Then explain how that index changes if you add per-tenant isolation (a `tenant_id` column). (Rubric: composite index leading with the most selective filter; partial index on `status = 'queued'` consideration; tenant_id as leading column for multi-tenant.)

- [ ] §2.1 complete

### §2.2 Isolation levels and MVCC (~30m)

**Objective.** Know the four standard isolation levels, what Postgres actually implements, and which level your worker pool needs.

**Concept.** SQL standard names four levels: **Read Uncommitted, Read Committed, Repeatable Read, Serializable**. They differ in which read anomalies they prevent: dirty reads, non-repeatable reads, phantom reads. Postgres implements **MVCC** (Multi-Version Concurrency Control): each transaction sees a snapshot of the database at the moment it acquires its snapshot. Every row has system columns (`xmin`, `xmax`) recording the inserting/deleting transaction id; visibility is computed against the snapshot.

What Postgres actually offers:

- **Read Committed (default).** Each statement sees a fresh snapshot. Suffers from non-repeatable reads and phantoms. Good enough for the typical worker pool — the claim's `UPDATE` re-checks the row condition.
- **Repeatable Read.** Snapshot is taken at transaction start; the same `SELECT` returns the same rows. Postgres uses *snapshot isolation* — phantoms are *also* prevented (stronger than the SQL standard's Repeatable Read). Conflicts surface as **serialization failures** at commit; you must retry.
- **Serializable.** Adds Serializable Snapshot Isolation (SSI) — Postgres detects read/write dependency cycles and aborts one transaction. Heaviest. Use when you have a true serialization invariant the schema can't express (e.g., "no two bookings overlap on resource X" without an exclusion constraint).

**Which level for your worker pool?** **Read Committed** + `FOR UPDATE SKIP LOCKED` is the canonical answer. The lock guarantees mutual exclusion on the *row*; you don't need snapshot stability across the whole TX.

**Maps to your code.** SQLite has only one isolation behavior (DEFERRED/IMMEDIATE/EXCLUSIVE on `BEGIN`); your `src/data-source.ts` doesn't set isolation explicitly. On Postgres, you'd be on Read Committed by default — that's correct for the claim path.

**Pause for questions.** *Any questions on §2.2 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. What does MVCC let Postgres avoid that traditional 2-phase locking doesn't?
2. What's the difference between Postgres's Repeatable Read and the SQL standard's Repeatable Read?
3. Why is Read Committed the right default for the worker-claim path?

<details><summary>Answer key</summary>

1. **Readers don't block writers and writers don't block readers.** Each transaction reads from a consistent snapshot; writers create new row versions instead of in-place updating, so concurrent reads see the old version until commit.
2. The SQL standard's Repeatable Read still permits phantom rows (new rows matching a `WHERE` clause appearing in a re-execution). Postgres uses snapshot isolation, which prevents phantoms too. So Postgres's Repeatable Read is *stronger* than the standard.
3. The `FOR UPDATE SKIP LOCKED` row-level lock provides the mutual exclusion the claim needs. Higher isolation buys snapshot stability for *other* statements in the TX, which the claim doesn't need — and it costs serialization failures + retries. Read Committed = least overhead, correct semantics.</details>

**Application question.** Interviewer: *"Suppose two workflows write to the same *`Result`* row in a hot path — when would you reach for Repeatable Read or Serializable?"* Walk through the decision in 60 seconds. (Rubric: name the read/write-set conflict; prefer schema constraints (`UNIQUE`, exclusion) before higher isolation; if you must, Serializable + retry-on-40001.)

- [ ] §2.2 complete

### §2.3 Advisory locks, deadlocks, hot-row contention (~30m)

**Objective.** Know the Postgres concurrency tools beyond row locks, and how to diagnose contention.

**Concept.** Three tools and one diagnosis skill:

1. **Advisory locks.** `pg_advisory_lock(key)` — application-defined lock identified by a 64-bit integer. Two flavors: session-scoped (released on disconnect) and transaction-scoped (released on commit/rollback). Use when you need a lock that *isn't* on a row — e.g., "only one process runs the nightly compaction" or "only one consumer for this tenant id at a time." For a worker pool, session-level advisory locks let you scale claim across processes when row-level locking is too coarse.
2. **Deadlocks.** Two transactions each hold a lock the other wants → Postgres detects the cycle (default: 1s after a wait starts) and aborts one (`40P01`). Common causes: locks acquired in different orders by different code paths; long-running TXs that grab many rows. **Mitigation:** always acquire locks in a consistent order (e.g., sorted by row id); keep TXs short; surface deadlock errors as retryable.
3. **Hot-row contention.** Many workers want the *same* row. `SKIP LOCKED` mitigates by spreading workers across many rows, but if all workers want one row (e.g., a counter), you need: (a) a sharded counter (write to one of N rows, sum on read); (b) batching via a queue; (c) rethinking the design.
4. **Diagnosis.** `pg_stat_activity` (currently running queries + wait events), `pg_locks` (who holds what), `pg_stat_user_tables.n_dead_tup` (autovacuum lag). The wait event tells you whether you're blocked on a lock, IO, or CPU.

**Maps to your code.** Your single-process worker pool doesn't need advisory locks. If/when you scaled to N Node processes, an advisory lock keyed by `tenant_id` (or a sharded counter for global throttling) would prevent two processes from claiming for the same tenant simultaneously — useful if your jobs do per-tenant work that mustn't interleave.

**Pause for questions.** *Any questions on §2.3 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. What does an advisory lock give you that a row lock doesn't?
2. Name the most common cause of deadlocks in an OLTP system, and the simplest mitigation.
3. What's the first system view you'd query to find out *why* a query is slow?

<details><summary>Answer key</summary>

1. A lock that's **not bound to a row** — application-defined keyspace. Lets you serialize on a logical resource (a tenant id, a job class, a maintenance task) without inventing a "lock table" with rows.
2. **Inconsistent lock ordering** — two transactions take locks A→B vs. B→A. Mitigation: always acquire locks in a deterministic order (sorted by row id, alphabetical, etc.). Plus: keep transactions short.
3. `pg_stat_activity` — shows the current query, its state (active/idle in transaction/waiting), and the **wait event** (Lock, IO, BufferMapping, etc.), which tells you what to look at next.</details>

**Application question.** Interviewer: *"In your *`taskRunner.ts`*, suppose you scaled to 4 Node processes and each had a pool of 3 workers — 12 workers total against one Postgres. What concurrency primitive would you reach for first, and why?"* Answer in 60 seconds. (Rubric: `FOR UPDATE SKIP LOCKED` is enough for claim spread across rows; advisory lock per `tenant_id` only if jobs must serialize per-tenant; explain the *why* before naming the primitive.)

- [ ] §2.3 complete

## §3 Distributed-systems vocabulary mapped to your MES (~2.5h)

**Section objective.** Translate your Selfbits MES experience into the vocabulary senior backend interviewers use. The point of this section is **mapping**: every concept gets a "what did you do at MES that's an example of this?" prompt.

### §3.1 Idempotency and delivery semantics (~30m)

**Objective.** Define idempotency rigorously, distinguish at-least-once / at-most-once / exactly-once, and recognize each in the wild.

**Concept.** A function is **idempotent** if calling it N≥1 times has the same effect as calling it once. The classic example: `set_balance(100)` is idempotent; `add_balance(+10)` is not. To make non-idempotent operations safe under retry, you attach an **idempotency key** to the request; the server records "I've already processed key K, returning the cached result."

Delivery semantics:

- **At-most-once.** The system may lose messages but never delivers duplicates. UDP, fire-and-forget logging.
- **At-least-once.** The system never loses messages but may deliver duplicates. Default for almost every reliable queue (SQS, Kafka with ack-on-commit, RabbitMQ with manual ack). Consumers **must** be idempotent.
- **Exactly-once.** The system guarantees neither loss nor duplication. **Almost always a marketing claim.** Real "exactly-once" is at-least-once delivery + idempotent processing on the consumer, or transactional sinks (Kafka EOS via the transactional producer + idempotent consumer).

**The senior framing.** Don't say "we use exactly-once." Say "we use at-least-once delivery with idempotent consumers, keyed by `<idempotency_key>`. Duplicates are detected at the persistence layer via a unique constraint on `(idempotency_key)`."

**Maps to your code + MES experience.** Your `taskRunner` is *not* idempotent today — re-running a `PolygonAreaJob` for the same `taskId` would write a new `Result`. In production you'd add an idempotency check (or rely on the optimistic version bump as the de-facto idempotency guard — only the version-matching attempt commits). At MES: how did you handle network drops between the factory floor terminal and the server? That's an at-least-once channel; whatever guard you used (request id, deduplication on receipt) is your idempotency story.

**Pause for questions.** *Any questions on §3.1 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. Define idempotency in one sentence.
2. Why is "exactly-once delivery" almost always a marketing claim, and what's the real-world equivalent?
3. What persistence-layer construct enforces idempotency for an at-least-once consumer?

<details><summary>Answer key</summary>

1. A function is idempotent if calling it N≥1 times has the same observable effect as calling it once.
2. Distributed systems can lose messages (network) and consumers can fail mid-processing (forcing re-delivery). You can't have both *no loss* and *no duplicates* without one side colluding (e.g., transactional sinks). The real-world equivalent is **at-least-once delivery + idempotent consumer**, often via an idempotency key.
3. A **unique constraint** on `(idempotency_key)` (or `(tenant_id, idempotency_key)`). The duplicate insert fails; the consumer treats the failure as "already processed" and returns the cached result.</details>

**Application question.** Pick one Selfbits MES feature you remember well. Describe one place where the system delivered an event at-least-once, and how (or whether) you guarded against duplicates. (Rubric: name the channel; identify the duplicate risk; describe the guard — even if the answer is "we didn't, and here's what would have happened.")

- [ ] §3.1 complete

### §3.2 Leases, fencing tokens, optimistic vs pessimistic locking (~30m)

**Objective.** Be precise about coordination primitives — when each one fits, what each one prevents, and what each one *fails to* prevent.

**Concept.**

- **Pessimistic locking.** Take the lock *before* you read; hold it until you commit. Postgres `SELECT … FOR UPDATE`. Other transactions wait. Right when contention is high and the cost of a wait is less than the cost of a retry.
- **Optimistic locking.** Read freely; on write, check that the row's `version` (or `updated_at`) hasn't changed; if it has, abort and retry. Right when contention is low and reads dominate. Your `taskWorker` claim uses this pattern.
- **Lease.** A *time-bounded* claim on a resource. The lease holder may use the resource until expiry; after expiry, anyone can take it. Used to recover from holder crashes. Requires a clock and a way to detect expiry.
- **Fencing token.** A monotonically increasing token issued *with* the lease. Storage rejects writes carrying an older token than the latest seen. Prevents the **zombie writer** problem: a holder that thinks it still owns the lease (because it was paused, GC'd, partitioned) coming back to write after a new holder has taken over.

**The classic Kleppmann argument.** A lease alone is not enough. If process A has the lease, GC-pauses for 30s, and process B takes the lease at second 20 and starts writing — when A wakes up, A *also* writes, thinking it's still the leader. Result: corrupted state. The fencing token prevents this: storage knows the latest token; A's write carries an older token and is rejected.

**Maps to your code + MES experience.** Your worker pool uses optimistic locking (version bump). It does *not* use leases or fencing tokens because §1.3's four-layer defense makes them unnecessary at this scope. At MES: did you ever have a "primary device" or "leader terminal" concept on the factory floor? If yes, that's a leadership problem; without fencing, you'd see the zombie-writer pattern when devices reconnected after a network drop.

**Pause for questions.** *Any questions on §3.2 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. When is optimistic locking the right choice over pessimistic?
2. What problem does a fencing token solve that a lease alone does not?
3. Your `taskWorker.ts` uses which kind of locking, and why is it sufficient here?

<details><summary>Answer key</summary>

1. **Low contention + reads dominate writes.** The retry cost is rare; the wait cost (with pessimistic) would dominate. Bonus: optimistic doesn't hold a row lock, so it doesn't block readers.
2. The **zombie-writer** problem. A lease holder paused (GC, partition) for longer than the lease lifetime can wake up and write, after a new holder has taken over. The lease alone says "you can use the resource"; the fencing token says "and the storage will reject your write if it's stale."
3. **Optimistic locking** (version bump). Sufficient because the four-layer defense (single-process, fresh-DB-on-boot, optimistic claim, per-job timeout) covers the failure modes leases would address — at this scope.</details>

**Application question.** Interviewer: *"You said 'optimistic claim with version bump.' Walk me through what happens, transaction by transaction, when two workers see the same *`queued`* task in the same tick."* Narrate the sequence. (Rubric: both `SELECT` see the row; both `UPDATE … WHERE version = $observed` race; one updates 1 row, the other updates 0 rows; the loser observes the affected-row count and re-polls.)

- [ ] §3.2 complete

### §3.3 Sagas, 2PC, eventual consistency, read-your-writes (~30m)

**Objective.** Speak to multi-service consistency without confusing the listener.

**Concept.**

- **2PC (two-phase commit).** A coordinator asks all participants "can you commit?"; they all reply yes/no; the coordinator then sends commit/abort to all. Strongly consistent across services. **Brittle:** the coordinator is a single point of failure; participants must hold locks during the prepare phase, blocking other work; long tail latency under failure. Rare in modern microservice stacks.
- **Saga.** A sequence of local transactions, each with a **compensating** transaction that undoes its effect. If step N fails, run compensations for steps 1..N-1 in reverse. Two flavors: **orchestrated** (a central orchestrator drives the sequence — easier to reason about, single point of complexity) and **choreographed** (each service emits events, others react — looser coupling, harder to debug). Saga gives you eventual consistency without 2PC's blocking semantics.
- **Eventual consistency.** Given no new updates, all replicas eventually converge. The trade-off vs. strong consistency: better availability and partition tolerance (CAP). Concrete consequence: a read after a write may not see the write.
- **Read-your-writes.** A consistency model that *guarantees* a client sees its own prior writes (even if other clients don't yet). Implemented via session affinity, version vectors, or routing reads through the primary.

**The senior framing.** Don't reach for 2PC. Reach for sagas (orchestrated for compliance-tech where auditability matters) when you need cross-service consistency. Be explicit about which reads need read-your-writes vs. which tolerate eventual consistency.

**Maps to your code + MES experience.** Your `WorkflowFactory` is a *baby orchestrator* — it sequences task creations and transitions, with the workflow `failed` sweep playing the role of compensation (it doesn't undo writes, but it stops scheduling). At MES: did you ever have a multi-service operation (e.g., "complete a production order" touching inventory + scheduling + KPI store)? If yes, that was a saga in disguise; if it didn't have explicit compensations, it was a saga *waiting to lose data*.

**Pause for questions.** *Any questions on §3.3 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. Why is 2PC rare in modern microservice stacks?
2. What's the difference between orchestrated and choreographed sagas, and which is better for compliance contexts?
3. Name one concrete consequence of eventual consistency that an end-user can observe.

<details><summary>Answer key</summary>

1. The coordinator is an SPOF; participants hold locks during the prepare phase (blocking other work); failure modes have long tail latency. Operationally brittle.
2. **Orchestrated** = a central orchestrator drives the sequence (easier to debug, audit, and reason about; single point of complexity). **Choreographed** = services react to each other's events (looser coupling, harder to trace). For compliance, **orchestrated** wins because the audit trail is centralized and the sequence is explicit.
3. A user updates their profile and immediately reloads — they see the *old* profile because the read hit a replica that hasn't caught up. Or: a write is acknowledged, but a search index hasn't ingested it yet, so search results lag.</details>

**Application question.** Sketch a saga for a hypothetical osapiens flow: "ingest a supplier ESG questionnaire response → validate → store → notify the buyer's compliance officer." Name two compensating transactions and the one place a real-world implementation would *skip* compensation and accept the inconsistency. (Rubric: name reasonable compensations; honest about which steps can't be undone — e.g., a sent email — and how you'd mitigate that operationally.)

- [ ] §3.3 complete

### §3.4 Backpressure, DLQ, work-stealing, poison messages (~30m)

**Objective.** Know the four most common queue-system failure modes by name and the standard mitigations.

**Concept.**

- **Backpressure.** Producers outpace consumers; the queue fills; eventually you OOM or drop messages. **Mitigations:** bounded queues with explicit drop/block policy; consumer-driven flow control (RxJS, Kafka pause/resume); rate limiting at the producer; auto-scaling consumers. Be explicit about which: silent drop is a data-loss bug; block is a latency bug; both are bugs unless documented.
- **Dead-letter queue (DLQ).** A side queue for messages that failed processing N times. Lets the main queue keep flowing while you triage poison messages. Critical for at-least-once delivery — without a DLQ, a poison message blocks the partition / consumer forever.
- **Work-stealing.** Idle workers pull work from busy workers' queues. Common in worker pools where work units have variable cost. Counter-pattern: per-worker queues with a global stealer thread. Your single-DB queue with `SKIP LOCKED` is *self-balancing* without explicit stealing because all workers pull from the same logical queue.
- **Poison messages.** Messages that cause the consumer to crash on every attempt (deserialization bugs, schema drift, malformed payloads). Without a DLQ, they re-deliver forever; with a DLQ, they go to the side queue after N attempts. Watch DLQ depth as an alert metric.

**Maps to your code.** You don't have a DLQ — failures send the workflow to `failed`, not the task to a retry path. That's the correct scope decision (documented in `interview/design_decisions.md`). In production: per-task retry policy with exp backoff + jitter, then DLQ; alert on DLQ depth; runbook for triage.

**Pause for questions.** *Any questions on §3.4 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. What are the two policies for handling a full bounded queue, and what's the bug each one introduces?
2. Why is a DLQ critical specifically for at-least-once delivery?
3. Why doesn't your worker pool need explicit work-stealing?

<details><summary>Answer key</summary>

1. **Drop** (silent or with a metric) — data-loss bug. **Block** (back the producer up) — latency bug, eventually a cascading failure. Both are bugs *unless documented and operationally accepted*. The honest answer is "drop with a metric and an alert" or "block with a circuit breaker upstream."
2. Because at-least-once means the broker keeps re-delivering until the consumer acks. A poison message that crashes the consumer never acks → infinite re-delivery → the partition or consumer is stuck forever. The DLQ is the escape hatch.
3. Because all workers pull from the same logical queue (one `tasks` table) via `SKIP LOCKED` (or your version-bump optimistic claim). Whoever asks next gets the next available row — the queue is naturally self-balancing. Work-stealing matters when each worker has its *own* queue and load is uneven.</details>

**Application question.** Interviewer: *"How would you decide the DLQ retry threshold for the *`ReportGenerationJob`* at osapiens? Walk me through the decision."* (Rubric: classify failures — transient (network) vs. permanent (bad input); set retries low for permanent (≤3); back off transient with jitter; alert on DLQ depth; never retry data-corruption errors.)

- [ ] §3.4 complete

### §3.5 The MES-to-vocabulary mapping drill (~30m)

**Objective.** Take five concrete features from your Selfbits MES years and re-tell each in distributed-systems vocabulary. This is the highest-leverage 30 minutes in §3 — it's where lived experience becomes interview language.

**Drill.** Pick **five** features/incidents you remember from MES (mobile app + factory floor + KPI store across 5 factories). For each one, fill in:

| MES feature/incident | Vocabulary term it exemplifies | Where it would live in this challenge's code |
| --- | --- | --- |
| (your example) | (idempotency / lease / saga / backpressure / etc.) | (src/...) |

**Examples to seed your thinking** (not yours — replace with your own):

- Mobile terminal sends a "machine started" event over flaky wifi → at-least-once delivery, idempotency key on `(machineId, eventId)`. Maps to "consumer must dedupe."
- Two terminals on the same shop floor briefly both think they're the active one → leadership / lease / fencing token. Maps to "we need fencing tokens or accept dirty writes."
- Nightly OEE rollup job stalls after 4h, blocking the next day's calc → poison message / per-job timeout. Maps to `taskRunner.ts` per-job timeout (production-grade addition).

**Maps to your code.** Each row's third column is the bridge: when the interviewer asks "how would this work in the system you wrote?", you point at the file. That's the moment lived experience and the artifact in front of them connect.

**Pause for questions.** *Any questions on §3.5 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. Why is this drill more valuable than memorizing definitions?
2. For each of your five MES examples, can you *immediately* name the vocabulary term and the file it would live in?
3. Which of your MES examples is the strongest "I shipped distributed-systems thinking before I had the words for it" story?

<details><summary>Answer key</summary>

1. Because interview answers land harder when they're *concrete*: "at MES we had X; in this code that's Y in `<file>`." That triple is what makes the answer believable. Memorized definitions sound like memorized definitions.
2. If yes — you're ready. If you hesitate on any one, that's the one to rehearse with the agent before §7 (STAR stories).
3. *(no key — pick the one and use it as the opener for §7.1.)*</details>

**Application question.** Pick the strongest example from the table. Tell the 90-second STAR story for it, *using the new vocabulary*. The agent grades whether the vocabulary fits naturally or feels bolted on. (Rubric: vocab is in service of the story, not the other way around; the STAR arc — situation, task, action, result — is intact; you name the trade-off you made.)

- [ ] §3.5 complete

## §4 Node concurrency model (~1h)

**Section objective.** Speak Node concurrency precisely — your daily bread, but sharpen the vocabulary and round out with broker comparison.

### §4.1 Event loop, microtasks vs macrotasks (~20m)

**Objective.** Walk through the event-loop phases without faltering, and explain why a sync `for` loop blocks everything.

**Concept.** Node's event loop runs in **phases** in a fixed order: timers (`setTimeout`/`setInterval`) → pending callbacks → idle/prepare → **poll** (I/O) → check (`setImmediate`) → close callbacks. Between phases, Node drains the **microtask queue** (resolved Promise `.then` callbacks, `queueMicrotask`) and the **process.nextTick** queue (higher priority than microtasks). Anything CPU-bound on the main thread blocks *all* of this — there is no preemption.

**Why this matters for your code.** Your worker pool's `taskWorker.ts` runs on the main event loop alongside Express request handlers. A synchronous CPU-heavy operation (e.g., huge JSON parse, a tight polygon-area calc on millions of vertices) blocks HTTP responses. The fix isn't "use threads everywhere" — it's: identify CPU-bound paths, move them to `worker_threads` *only* if the cost justifies the IPC overhead. Most "slow" Node code is actually waiting on I/O (DB, HTTP) — and Node already handles I/O concurrency natively via the libuv thread pool.

**Maps to your code.** `src/jobs/PolygonAreaJob.ts` is CPU-light (small geometry); `src/jobs/ReportGenerationJob.ts` is I/O-light (in-memory work + DB). At 1000× input size, polygon area becomes worth a `worker_thread`; until then, the per-task transaction in `src/workers/taskRunner.ts` is bound by DB latency, not CPU.

**Pause for questions.** *Any questions on §4.1 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. Name the event-loop phases in order.
2. What's the difference between `process.nextTick` and `queueMicrotask`?
3. Why is "use worker_threads for everything slow" usually wrong advice?

<details><summary>Answer key</summary>

1. Timers → pending callbacks → idle/prepare → poll (I/O) → check (`setImmediate`) → close callbacks. Microtasks drain between every phase boundary.
2. **Both** run before the next macrotask. `process.nextTick` runs *first* (higher priority queue); `queueMicrotask` (and resolved Promise `.then`) runs after. Abuse of `process.nextTick` can starve I/O.
3. Most "slow" code is **I/O-bound**, not CPU-bound. Node already handles I/O concurrency well; moving I/O work into a worker thread adds IPC overhead with no parallelism benefit. Reserve `worker_threads` for genuine CPU-bound work that justifies the cost of structured-cloning data across the thread boundary.</details>

**Application question.** Profile-mind exercise: name three Node-specific symptoms that tell you the event loop is being blocked, and the tool you'd use to confirm each. (Rubric: rising p99 latency on unrelated endpoints; `--prof` / clinic.js / 0x; `perf_hooks.monitorEventLoopDelay`; the `nodejs_eventloop_lag` metric in your APM.)

- [ ] §4.1 complete

### §4.2 worker_threads vs cluster vs child_process (~20m)

**Objective.** Pick the right Node concurrency primitive for the right job.

**Concept.**

- `worker_threads` — true OS threads sharing the process. Communicate via `MessagePort` (structured clone) or `SharedArrayBuffer`. Right for CPU-bound work that needs to share data efficiently.
- `cluster` — multiple Node *processes*, one per CPU core, sharing the listening socket via the master process. Right for scaling HTTP throughput on a single machine. Each worker is its own V8 isolate; no shared memory; communicate via IPC.
- `child_process` — spawn an arbitrary process (Node or other). Right for shelling out (running ffmpeg, a Python script). Communicates via stdio or IPC.

**The senior framing.** In containerized deployments, `cluster` is largely obsolete — your container orchestrator (K8s) does the same thing (one container per process). `worker_threads` survives because it's the only way to get *intra-process* CPU parallelism. `child_process` is for genuinely external binaries.

**Maps to your code.** Your worker pool is N **coroutines on the main event loop** — not threads, not processes. The defense file `interview/coroutine-vs-thread.md` covers exactly this distinction. The right time to add `worker_threads` is when one job class is CPU-heavy enough that its execution blocks Express handlers; the right time to scale to multiple Node processes is when one process can't keep up with HTTP concurrency.

**Pause for questions.** *Any questions on §4.2 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. Why is `cluster` largely obsolete in container orchestrators?
2. What's the cost of moving work to `worker_threads`, and when is the cost justified?
3. What does the term "coroutine" mean in your `interview/coroutine-vs-thread.md`?

<details><summary>Answer key</summary>

1. Container orchestrators run one process per container and scale horizontally; the master/worker pattern of `cluster` duplicates the orchestration the platform is already doing. Plus: per-process metrics, restarts, and resource limits are cleaner per-container.
2. **Cost:** structured clone of all data crossing the thread boundary; no direct memory sharing (except `SharedArrayBuffer`); IPC latency. **Justified** when CPU-bound work would otherwise block the event loop *and* the data movement cost is small relative to the compute cost.
3. A unit of cooperative concurrency on a single event loop — not preemptive, not OS-threaded. Each "worker" in your pool is an `async` function that takes a turn at the loop. Defense: `interview/coroutine-vs-thread.md`.</details>

**Application question.** Interviewer: *"You said your worker pool runs N coroutines on one event loop. Why isn't this just slower than N OS threads?"* Answer in 60 seconds. (Rubric: I/O-bound work overlaps via libuv thread pool; cooperative scheduling has zero context-switch cost; the bottleneck is DB latency, not CPU; threads would help only if jobs are CPU-bound.)

- [ ] §4.2 complete

### §4.3 Queue-broker comparison (~20m)

**Objective.** Have a one-liner per major broker so you don't freeze on "what would you use in production?"

**Concept.**

| Broker | Model | Strengths | Weaknesses | When to pick |
| --- | --- | --- | --- | --- |
| BullMQ (Redis-backed) | Job queue with retries, delayed jobs, repeating jobs | Easy in Node; rich semantics; great DX | Redis as SPOF unless clustered; not a true streaming log | Single-region Node app; <1k jobs/sec; jobs with rich retry policies |
| Redis Streams | Append-only log with consumer groups | Lower op overhead than Kafka; fast | Limited persistence (RDB/AOF); no compaction; scaling is more manual | Same as BullMQ but you want consumer-group semantics and replay |
| RabbitMQ | Smart broker, dumb consumer; exchanges + queues | Rich routing (topic, fanout, headers); mature | Throughput ceiling lower than Kafka; ops cost moderate | Heterogeneous consumers; complex routing; <10k msg/sec |
| Kafka | Distributed commit log; consumer groups; partitions | Massive throughput; durable replayable log; ordering per partition | Heavy ops cost; high tail latency; rebalance storms; ZK/KRaft complexity | High-throughput event streams; replay for compliance; multi-team data backbone |
| SQS (AWS) | Managed at-least-once queue | Zero ops; pay-per-use | At-least-once duplicates; no ordering (FIFO variant has lower throughput) | AWS-native, simple work distribution |
| Postgres + SKIP LOCKED | (your §2.1) | No new infra; transactional with the data | <10k claims/sec ceiling | Early scale; want data + queue in one TX |

**The senior framing.** The right answer is *almost never* "Kafka by default." For osapiens-style compliance-tech, the dominant constraints are likely: durability (audit), replayability (re-run failed analyses), and per-tenant ordering. Kafka fits that — but if you're at <1k msg/sec, **Postgres + **`SKIP LOCKED` wins on op cost and transactional locality with the rest of the data.

**Maps to your code.** Your in-DB queue *is* the simplest broker on this list. The migration path: Postgres + `SKIP LOCKED` → BullMQ (when you outgrow DB-as-queue but don't need a log) → Kafka (when you need replayability and per-tenant ordering at high throughput).

**Pause for questions.** *Any questions on §4.3 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. Why is "use Kafka" rarely the right answer below ~10k msg/sec?
2. What does Kafka give you that BullMQ does not, that matters for compliance?
3. When would you pick RabbitMQ over Kafka?

<details><summary>Answer key</summary>

1. Kafka has high op cost (cluster, ZK/KRaft, topic mgmt, consumer rebalance), high tail latency under failure, and a steep learning curve. Below ~10k msg/sec, Postgres-as-queue or BullMQ delivers the same business outcome with a tenth of the ops.
2. **A durable, replayable, ordered log.** You can re-run the last 30 days of events through a new consumer (e.g., a new compliance check) without replaying side effects on the producer. BullMQ retains jobs only until they complete (configurable), not as a long-term log.
3. When you need **rich routing** (topic patterns, fanout, header-based) more than you need throughput. Heterogeneous consumers with different filtering rules → RabbitMQ. High-throughput same-shape stream → Kafka.</details>

**Application question.** Interviewer: *"Walk me through the queue-broker decision for osapiens, given they need long-term retention of supplier evidence ingestion events."* (Rubric: pin requirements (durability, replay, per-tenant ordering, throughput); compare 2–3 brokers against those; pick one and name what you'd give up.)

- [ ] §4.3 complete

## §5 Multi-tenant SaaS security (~2h)

**Section objective.** This is the **biggest gap area** in your prep relative to the role. Two hours is enough to cover the topics you'll be asked about; the goal is fluency, not depth.

### §5.1 Tenant isolation patterns (~30m)

**Objective.** Compare three tenant-isolation patterns precisely; pick one for an osapiens-shaped product.

**Concept.** Three patterns, increasing isolation:

1. **Row-level (shared schema).** All tenants share the same tables; every row carries `tenant_id`; every query filters on it. Postgres **Row-Level Security (RLS)** policies enforce filtering at the DB level so an app bug can't leak rows. **Pros:** lowest cost; easiest schema migrations; best resource utilization. **Cons:** a single noisy tenant affects all; per-tenant backup/restore is hard; one bad migration affects everyone; "delete all tenant X data" is a query, not an operation.
2. **Schema-per-tenant.** One Postgres schema per tenant; same DB instance. **Pros:** strong logical isolation; easier per-tenant backup; tenant migration to a different DB is cleaner. **Cons:** schema sprawl; migrations must run N times; connection pooling per schema is awkward.
3. **Database-per-tenant.** One DB instance per tenant. **Pros:** strongest isolation; per-tenant tuning, encryption keys, regions; trivially compliant with data-residency. **Cons:** N× ops cost; connection management; cross-tenant analytics needs a separate warehouse.

**The senior framing.** The choice is driven by **isolation requirements + cost tolerance + tenant size distribution**. SaaS with thousands of small tenants → row-level + RLS. Compliance-tech with enterprise customers requiring data residency / dedicated keys → schema-per-tenant or DB-per-tenant for the top tier; row-level for the SMB tier (a "tiered" model).

**Maps to your code.** Your system has no tenant concept today (single-tenant by omission). The minimum-invasive add for production: `tenant_id` column on `Workflow`, `Task`, `Result`; an index leading with `tenant_id`; an RLS policy `USING (tenant_id = current_setting('app.tenant_id'))`; the route handlers `SET LOCAL app.tenant_id = $jwt.tenant_id` at the start of each request.

**Pause for questions.** *Any questions on §5.1 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. What does Postgres RLS give you that an app-side `WHERE tenant_id = ?` does not?
2. When would you pick schema-per-tenant over row-level?
3. What's the *tiered* multi-tenant model, and why does it exist?

<details><summary>Answer key</summary>

1. **Defense in depth.** RLS enforces the filter at the DB; an app bug, a buggy ORM, or a forgotten `WHERE` cannot leak across tenants. App-side filtering relies on the developer being perfect; RLS makes the wrong query *impossible* to write.
2. When per-tenant backup, per-tenant migration, or per-tenant performance tuning matters more than ops cost. Common in B2B with mid-sized customers.
3. Different isolation tiers per customer segment (row-level for SMB, DB-per-tenant for enterprise). Exists because customer requirements diverge — a Fortune-500 bank's data-residency demands aren't worth eating across thousands of free-tier accounts.</details>

**Application question.** Sketch the migration plan to add multi-tenancy to your current code with row-level + RLS. Name the *one* test you'd write first to prevent regressions. (Rubric: schema change with NOT NULL `tenant_id`; backfill; RLS policy; `SET LOCAL`; the test = "two workflows from two tenants; tenant A's `/results` returns 404 for tenant B's workflow even with a guessable id.")

- [ ] §5.1 complete

### §5.2 OAuth2 / OIDC flows + JWT pitfalls (~30m)

**Objective.** Pick the right OAuth2 grant for the right context; name the four most common JWT footguns.

**Concept.**

**OAuth2 grants in the wild today:**

- **Authorization Code + PKCE.** The default for *both* SPAs and mobile apps (the "implicit grant" is deprecated). User redirects to IdP, gets an auth code, the client exchanges it for tokens with a `code_verifier`. PKCE prevents code interception.
- **Client Credentials.** Service-to-service (no user). The service authenticates with its own credentials and gets a token.
- **Refresh Token Rotation.** Each refresh issues a new refresh token; the old one is invalidated. Detects token theft (if both old and new are used, revoke the chain).
- **Device Code.** For TVs / CLIs without a browser.

**OIDC** is OAuth2 + an `id_token` (JWT) describing the user. Authentication on top of OAuth2's authorization.

**JWT footguns:**

1. `alg: none`**.** Old libraries accept tokens with no signature. Always validate `alg` against an allowlist.
2. **Key confusion (RS256 ↔ HS256).** A library accepts an HS256 token signed with the public key (interpreted as a shared secret). Pin the algorithm.
3. **Long expiry, no revocation.** JWTs are stateless — you cannot revoke a long-lived JWT cheaply. Use short access tokens (5–15 min) + refresh tokens (with rotation + revocation list) for sensitive flows.
4. **Sensitive data in the payload.** JWT payloads are base64-encoded, not encrypted. Anything in the payload is public. Use opaque session tokens if the payload is sensitive.

**Maps to your code.** Your routes have no auth (`interview/design_decisions.md`: *"No authentication / authorization on any endpoint."*). For osapiens-style production, the canonical add: an Express middleware that validates the `Authorization: Bearer <jwt>` header against the IdP's JWKS, populates `req.user` and `req.tenantId`, and the route handlers `SET LOCAL app.tenant_id` for RLS (§5.1).

**Pause for questions.** *Any questions on §5.2 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. What's the modern default OAuth2 flow for a SPA, and what does PKCE prevent?
2. Why are short-lived access tokens + rotated refresh tokens the standard pattern?
3. Name two ways an attacker bypasses JWT signature verification.

<details><summary>Answer key</summary>

1. **Authorization Code + PKCE.** PKCE prevents an attacker who intercepts the auth code (e.g., in a malicious mobile app, browser extension) from exchanging it for tokens — only the original client knows the `code_verifier`.
2. JWTs are stateless and hard to revoke at scale. Short access tokens (5–15 min) bound the damage of theft. Refresh tokens are *checkable* (rotated, kept in a revocation list); rotation also detects theft (both old + new used).
3. `alg: none` acceptance; **key confusion** (signing an HS256 token with the public key the library expected for RS256). Both have caused real-world breaches.</details>

**Application question.** Interviewer: *"You've added auth to this challenge code. The frontend is React, the backend is Node. Walk me through one full request — login → token → protected *`POST /analysis`*."* (Rubric: SPA does Auth Code + PKCE; backend validates JWT against JWKS; middleware sets `req.user` + `req.tenantId`; `SET LOCAL app.tenant_id`; route runs; tokens never cross to the worker pool — workers operate on rows already filtered by tenant at insert time.)

- [ ] §5.2 complete

### §5.3 OWASP top 10 + rate limiting + secret management (~30m)

**Objective.** Be able to name the OWASP Top 10 with one-line mitigations, and describe production-grade rate limiting and secret management.

**Concept.**

**OWASP Top 10 (2021), one-line mitigations:**

1. **Broken Access Control** — server-side authorization checks on every endpoint; never trust client-side hiding; default-deny.
2. **Cryptographic Failures** — TLS everywhere; modern ciphers; encrypt sensitive data at rest; rotate keys.
3. **Injection** (SQL, NoSQL, command) — parameterized queries (your TypeORM does this); input validation; least-privilege DB users.
4. **Insecure Design** — threat model early; security in the design phase, not bolted on.
5. **Security Misconfiguration** — secure defaults; no default credentials; minimal attack surface; CSP/HSTS headers.
6. **Vulnerable & Outdated Components** — `npm audit` in CI; dependabot; SCA tooling.
7. **Identification & Authentication Failures** — strong password reqs; MFA; rate-limit auth endpoints; secure session mgmt.
8. **Software & Data Integrity Failures** — verify update signatures; SBOM; supply-chain controls.
9. **Security Logging & Monitoring Failures** — log auth events, access-control failures, server-side errors; alert on anomalies.
10. **Server-Side Request Forgery (SSRF)** — allowlist outbound URLs; deny private IP ranges; validate URLs at the edge.

**Rate limiting** — bucket-based (token bucket, leaky bucket), keyed by client IP / API key / user id. Layer at edge (CDN) + app (per-route). For SaaS, also per-tenant quotas. Express middleware: `express-rate-limit` for simple cases; Redis-backed for multi-instance.

**Secret management** — never in code; never in env files committed to git; use a vault (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager). Pattern: app fetches secrets at boot (or via init container), not on every request. Rotate regularly; audit access.

**Maps to your code.** Your code has no auth, no rate limiting, no secret management — all explicitly out of scope (`interview/design_decisions.md`). For production: middleware stack `helmet → cors → rate-limit → auth → tenant-context → route`. Secrets via env vars *injected by the orchestrator from a vault*, never committed.

**Pause for questions.** *Any questions on §5.3 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. What's the #1 OWASP risk, and the one-line mitigation?
2. Why rate-limit by *user / API key / tenant* and not just IP?
3. What's the standard way to get secrets into a Node app in production?

<details><summary>Answer key</summary>

1. **Broken Access Control.** Mitigation: server-side authorization on every endpoint; default-deny; never rely on hidden UI as a security boundary.
2. IPs are shared (NAT, mobile carriers, corporate proxies). A noisy office's IP could rate-limit all real users. Per-user / per-API-key / per-tenant gives accurate attribution and per-tenant quotas (which is also a billing primitive).
3. **From a vault, injected by the orchestrator at deploy time as env vars** (or mounted as files via a sidecar). The app reads them at boot. Never in source code, never in `.env` files committed to git, never on every request.</details>

**Application question.** Pick one OWASP Top 10 risk that's *most relevant* to a system like the one you wrote — even though no auth is wired up. Defend the choice and name the production fix. (Rubric: most likely answers are Injection (covered by ORM parameterization), Broken Access Control (no auth = the *whole* surface is broken), or Security Logging & Monitoring (your `logger.ts` is a foundation but lacks security-event taxonomy).)

- [ ] §5.3 complete

### §5.4 Audit logging — append-only and tamper-evident (~30m)

**Objective.** Distinguish operational logging from audit logging; describe a production-grade audit trail for compliance-tech.

**Concept.** Operational logs (your `src/utils/logger.ts`) are for debugging and ops — they are mutable, retention is short, sampling is acceptable. **Audit logs** are for compliance — they are **append-only**, **immutable**, fully retained per the regulatory clock, and ideally **tamper-evident**.

**Patterns:**

1. **Append-only table** with no `UPDATE` / `DELETE` permission for the app user (DB-enforced). Indexed by `(tenant_id, actor, event_type, ts)`.
2. **Hash-chained entries.** Each entry includes `prev_hash = sha256(prev_entry)`. Tampering with any entry breaks the chain. Used in finance, healthcare, ESG audit trails.
3. **External write target.** Audit events go to a separate store (often append-only object storage with object lock, or a dedicated audit DB) so a compromise of the app DB doesn't compromise the audit trail.
4. **What to log.** Authentication events; authorization decisions (especially denials); reads of sensitive data; all writes to regulated data; configuration changes; exports.
5. **What NOT to log.** PII in payloads (log the *fact* of access, not the *content*); secrets; full HTTP bodies on regulated endpoints.

**The compliance framing.** ESG / GDPR / SOC2 audits ask "show me who accessed customer X's data on date Y, what they did, and prove the log wasn't tampered with." Your audit design exists to make that question answerable.

**Maps to your code.** Your `src/utils/logger.ts` is operational. For osapiens, you'd add an `AuditLog` entity + repository, an append-only constraint (DB role with no UPDATE/DELETE), and middleware that emits an audit event for every state-changing route + every auth decision. The hash chain is a per-tenant sequence: `prev_hash = sha256(prev_audit_log_entry)` keyed by `(tenant_id, sequence_id)`.

**Pause for questions.** *Any questions on §5.4 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. Name three structural differences between operational and audit logs.
2. What does hash-chaining give you that append-only alone does not?
3. Why is "log the access, not the content" a critical rule for regulated data?

<details><summary>Answer key</summary>

1. (a) **Mutability** — operational mutable / audit immutable. (b) **Retention** — operational short / audit per regulatory clock. (c) **Permissions** — operational app-writable, app-deletable / audit append-only at the DB level.
2. **Tamper evidence.** Append-only prevents *the app* from rewriting; hash-chaining prevents *anyone with DB access* from silently modifying past entries — a change breaks every subsequent hash, which is detectable at audit time.
3. Logs themselves can leak. If the access log contains the SSN that was looked up, the log is now a copy of the SSN — same regulatory weight, same breach risk. Log "user X read SSN field of customer Y at time Z" — fact-of-access, not content.</details>

**Application question.** Design the minimum-viable audit log for the *current* challenge code as if osapiens were operating it. Name the entity, the columns, the three events you'd record from the existing routes, and the one place the design would *fail* a SOC2 audit. (Rubric: include `prev_hash`; record `POST /analysis`, `GET /results`, and worker-side `Task → completed/failed`; failure = no auth context to attribute the actor — must be added before audit is meaningful.)

- [ ] §5.4 complete

## §6 Compliance domain for osapiens (~1h)

**Section objective.** Sound informed about the regulatory context osapiens operates in. You don't need to be a lawyer; you need to talk about ESG/GDPR/SOC2 without sounding green.

### §6.1 GDPR-as-processor essentials (~20m)

**Objective.** Know the GDPR concepts most relevant to a SaaS *processor* (osapiens-as-vendor processing customer data).

**Concept.**

- **Controller vs. Processor.** The customer (osapiens's customer) decides *what* data to collect and *why* — they're the **controller**. Osapiens processes that data on their behalf — **processor**. The processor's obligations are smaller but well-defined.
- **DPA (Data Processing Agreement).** Mandatory contract between controller and processor. Specifies purpose, duration, sub-processors, data categories, security measures, breach notification timelines.
- **Sub-processors.** Anyone osapiens uses that touches customer data (AWS, an email service, etc.). Customer must approve the list; processor must notify on changes.
- **Right to erasure (Art. 17).** Controller asks the processor to delete a data subject's data. Processor must comply *and* prove deletion (logs, attestation). Designed-in: every entity carrying personal data needs a deletion path.
- **Data residency.** Some controllers (especially EU-only) require data stays in a specific region. Drives DB-per-tenant or region-locked deployments (§5.1).
- **Breach notification.** Processor must notify controller "without undue delay" on becoming aware of a breach. Controller has 72h to notify the supervisory authority. Tight ops timeline.

**The senior framing.** GDPR isn't a checklist your security team owns; it's a **set of design constraints** on data models (deletion paths), deployment (residency), audit (proof of deletion), and ops (breach response runbook).

**Maps to your code + osapiens context.** Your code has no PII today, so GDPR is academic for the artifact. The talking-point: *"If this were processing personal data, the design changes I'd make are: deletion-by-tenant via cascading FK or a soft-delete *`deleted_at`* with a scheduled hard-delete; per-tenant region affinity; audit-trail entry on every read/write; breach-detection hooks on the auth + DB layer."*

**Pause for questions.** *Any questions on §6.1 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. Are you the *controller* or *processor* if you're osapiens, and what's the obligation difference?
2. What's the breach-notification timeline a processor commits to?
3. What's the design implication of Art. 17 (right to erasure) on every entity that carries personal data?

<details><summary>Answer key</summary>

1. **Processor.** The customer is controller. Processor's obligations are narrower (act on documented instructions, security measures, sub-processor management, breach notification, audit assistance) but legally binding via the DPA.
2. **"Without undue delay" on becoming aware.** Practically: hours, not days. The controller then has 72h to notify the supervisory authority. Tight enough that you need a runbook, not an ad-hoc response.
3. Every entity carrying personal data needs a **deletion path** — either a deletion query, a cascading FK, or a soft-delete + scheduled purge. Every backup also needs a deletion strategy (often: don't restore deleted rows, or accept that backups age out within retention).</details>

**Application question.** Imagine osapiens stores supplier-employee names + emails in a "supplier ESG questionnaire response" entity. A controller asks for an Art. 17 deletion for a specific employee. Walk through the implementation in 60 seconds — schema, query, audit, attestation. (Rubric: identify all FK paths the row lives in; transactional delete; audit-log the deletion (without logging the deleted content); return an attestation to the controller; backups age-out policy disclosed in the DPA.)

- [ ] §6.1 complete

### §6.2 SOC 2 Type 2 — what the audit actually checks (~20m)

**Objective.** Know what SOC 2 Type 2 is, the trust criteria, and what the audit looks for in practice.

**Concept.**

- **SOC 2** is an attestation report (not a certification) by a CPA firm against the **AICPA Trust Services Criteria**: Security (mandatory), Availability, Processing Integrity, Confidentiality, Privacy (the latter four are optional add-ons).
- **Type 1** = controls *exist* at a point in time. **Type 2** = controls *operated effectively* over a period (typically 6–12 months). Type 2 is the one customers actually ask for.
- **Common criteria (CC series)** under Security cover: control environment, communication, risk assessment, monitoring activities, control activities, **logical and physical access controls**, **system operations**, **change management**, **risk mitigation**.
- **What the audit actually checks.** Sample-based evidence: "show me 25 random access reviews from the last quarter," "show me the change tickets for this 30-day window," "show me the on-call rotation that responded to this incident." Auditors don't read code; they read tickets, logs, screenshots, and policy documents.

**The senior framing.** SOC 2 Type 2 is **process, not product**. The interview-grade insight is that engineering practices that *generate evidence* (PR reviews, change tickets linked to deploys, access reviews on a cadence, audit logs that survive deletion) make audits cheap. Practices that *don't* leave a trail make audits expensive — even when the practices are sound.

**Maps to your code + repo practices.** Your `CLAUDE.md` quality gates (pre-commit + pre-push, conventional commits with task references, one-commit-per-task) are *exactly* the kind of evidence-generating practice SOC 2 auditors love. Your `interview/manual_test_plan/` scripts are evidence of test rigor. The repo-as-audit-trail framing is a strong osapiens talking point.

**Pause for questions.** *Any questions on §6.2 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. Type 1 vs. Type 2 — what's the difference and which do customers ask for?
2. What does a SOC 2 auditor actually look at — code, tickets, both?
3. Name two engineering practices that generate SOC 2 evidence "for free."

<details><summary>Answer key</summary>

1. **Type 1** = controls exist at a point in time (snapshot). **Type 2** = controls operated effectively over a period (typically 6–12 months). Customers ask for **Type 2**.
2. **Tickets, logs, screenshots, policy docs, PR records, access-review records.** Not the code itself. Auditors verify processes operated; they're not security engineers reviewing implementations.
3. **Conventional commits + linked tickets** (change-management evidence). **Pre-merge code review** (segregation of duties). **Audit log retention** (logical access). **Quarterly access review** (privileged access). **Incident postmortems** (problem mgmt).</details>

**Application question.** Interviewer: *"How would your CLAUDE.md / Husky / PR practices in this repo support a SOC 2 audit?"* Answer in 60 seconds. (Rubric: change management = conventional commits + PR review + linked task ids; segregation of duties = pre-merge review; system operations = pre-push test gate; supply-chain = `npm audit` if added; explicitly name what's *missing* — access review cadence, incident response logs.)

- [ ] §6.2 complete

### §6.3 CSRD / ESRS context (~20m)

**Objective.** Know what osapiens's customers are using the product *for*, in regulatory terms. You don't need depth — you need to not be confused when the term comes up.

**Concept.**

- **CSRD (Corporate Sustainability Reporting Directive).** EU law (in force from 2024 with phased application). Requires ~50,000 EU and non-EU companies to publish detailed sustainability reports with the same rigor as financial reports. Externally audited.
- **ESRS (European Sustainability Reporting Standards).** The actual reporting framework CSRD points at. Twelve standards covering environmental (climate, pollution, water, biodiversity, circular economy), social (workforce, value chain workers, communities, consumers), and governance (business conduct).
- **Double materiality.** A reporting principle: companies must disclose both (a) how sustainability matters affect the company (financial materiality) and (b) how the company affects sustainability (impact materiality). This is what makes CSRD demanding — both perspectives.
- **Value chain / supplier data.** Companies must report on their supply chain too (Scope 3 emissions, supplier human-rights diligence). This is where SaaS like osapiens earns its keep — collecting, validating, and aggregating supplier-reported data across thousands of suppliers.
- **Adjacent regs.** CSDDD (Corporate Sustainability Due Diligence Directive — supply-chain due diligence), EUDR (deforestation regulation), CBAM (carbon border adjustment), EU Taxonomy. Customers often need *all* of them in one tool.

**The osapiens talking point.** *"The product domain is collecting evidence from a long tail of suppliers, validating it against an evolving regulatory framework, and producing audit-ready reports. The interesting backend problems are: high-volume supplier data ingestion (queue + workflow patterns this challenge exercises), schema-on-read for regulatory frameworks that change faster than a fixed schema can keep up with, and audit-grade data lineage from raw input to published report."*

**Maps to your code.** Your DAG-of-tasks workflow engine *is* a useful primitive for this domain — different evidence types need different validation/transformation pipelines, with explicit dependencies. The `WorkflowFactory` + `Job` plug-in pattern would carry over to "register a new evidence-type job."

**Pause for questions.** *Any questions on §6.3 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**

1. What's the difference between CSRD and ESRS?
2. What does "double materiality" mean and why is it demanding?
3. Name one regulation adjacent to CSRD that an osapiens customer might also need to comply with.

<details><summary>Answer key</summary>

1. **CSRD** is the EU law that *requires* sustainability reporting. **ESRS** is the *standard* that defines what to report and how. CSRD is the legal mandate; ESRS is the framework.
2. Both *outside-in* (how sustainability affects the company financially) **and** *inside-out* (how the company affects sustainability). Demanding because companies must invest in measuring impacts that don't directly affect their P&L (emissions, supply-chain labor practices), and back it up with audit-grade evidence.
3. Examples: **CSDDD** (supply-chain human rights / environmental due diligence), **EUDR** (deforestation), **CBAM** (carbon border adjustment mechanism), **EU Taxonomy** (which activities count as "green").</details>

**Application question.** In 60 seconds, pitch why your DAG workflow engine in this challenge is a sensible primitive for the osapiens product domain — *without* over-claiming. (Rubric: name the fit (per-evidence-type plug-in pipelines, explicit dependencies, audit-trail-friendly task lifecycle); name the *gap* (no schema-on-read, no per-tenant config, no evidence-source connectors, no human-in-the-loop review state); avoid pretending to know the product better than they do.)

- [ ] §6.3 complete

---

## §7 STAR stories polished (~1.5h) <!-- status: todo -->

**Section objective.** Polish four 90-second stories so they're *reflexive*, not improvised. Each story has a fixed structure (Situation → Task → Action → Result) with one explicit *trade-off named* and one *thing you'd do differently with hindsight*.

### §7.1 Selfbits MES — distributed multi-site backend (~25m) <!-- status: todo -->

**Objective.** Tell the MES story in distributed-systems language. This is the load-bearing story for "do you have backend depth?"

**Concept (story scaffold).**

- **Situation.** "At Selfbits I was the founding engineer on a SaaS Manufacturing Execution System. We grew to 200+ users across 5 European factories in 2 timezones, with web + mobile + factory-floor TV terminals all writing to a shared backend."
- **Task.** [Pick **one** specific challenge: e.g., "the factory-floor terminals were on intermittent wifi and were the source of truth for OEE events" or "the nightly KPI rollup had to be consistent across timezones."] State the requirement crisply.
- **Action.** [The technical move you made — name 2–3 specific decisions in distributed-systems vocabulary, map each to the trade-off you weighed.]
- **Result.** [Concrete outcome — over what timeframe — what was the user-visible win.]
- **Trade-off you named.** [What did you *not* solve, and why was that the right call at the time.]
- **Hindsight.** [One thing you'd do differently. *Required* — interviewers respect this.]

**Maps to your code in this repo.** When the interviewer says "what does this look like in this code?" — you point at:
- `src/workflows/WorkflowFactory.ts` if the story was about orchestration
- `src/workers/taskWorker.ts` if it was about queue contention
- `interview/no-lease-and-heartbeat.md` if it was about coordination

**Pause for questions.** *Any questions on §7.1 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**
1. Can you tell the story in 90 seconds without notes?
2. Which distributed-systems vocab term anchors the story?
3. What's the *one trade-off you named* and the *one hindsight*?

<details><summary>Answer key</summary>

1. *(no key — record yourself; if you exceed 100s, cut.)*
2. *(no key — should be one of: at-least-once delivery, optimistic locking, saga, eventual consistency, backpressure. Pick the one that's actually load-bearing in your story.)*
3. *(no key — but if you can't name one of each, the story isn't done.)*
</details>

**Application question.** Tell the story to the agent out loud, with a 90-second timer. The agent grades against the rubric: did the vocab fit naturally; was the trade-off named; was hindsight honest; did the result quantify? (Rubric: yes/no on each — the agent gives one sharper reframing.)

- [ ] §7.1 complete

### §7.2 Audi XL2 — enterprise stakeholder mgmt + delivery (~25m) <!-- status: todo -->

**Objective.** Lead-grade story: cross-functional team, hard stakeholder, delivery against pressure.

**Concept (story scaffold).**

- **Situation.** "At XL2 by Audi & Capgemini, I led a 7-member team (analyst, designer, 5 developers) on a multi-million Euro Audi digitization project — building the system that lets stakeholders approve and sign off serial-production car parts in meetings."
- **Task.** [Pick the moment of stakeholder tension or delivery pressure — e.g., "we shipped V1 in 6 months and hit a 30-min reduction on critical meetings; the moment that mattered was [X]."]
- **Action.** [Lead-grade decisions: scope cut, requirements re-grilling, team reshuffling, escalation, technical bet. Pick 2–3.]
- **Result.** "Reduced critical meeting duration by 30 minutes within 6 months, enabling stakeholders to approve and sign off serial production digitally."
- **Trade-off named.** [What did you say no to to hit the deadline?]
- **Hindsight.** [What would you have done differently — likely either earlier requirements clarification or earlier scope negotiation.]

**Pause for questions.** *Any questions on §7.2 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**
1. What's the *one number* in this story (the result)?
2. Did your "Action" name a leadership move (not just an engineering one)?
3. Is the trade-off something you'd actually defend, or is it fake humility?

<details><summary>Answer key</summary>

1. **30 minutes** of meeting time saved within **6 months**.
2. *(no key — but if your action is purely technical, the story is mis-pitched. Lead roles want the leadership move first, the technical move second.)*
3. *(no key — common mistake: "we cut scope" is fake humility unless you can name the *specific feature* you cut and what it cost.)*
</details>

**Application question.** Tell the 90-second story. Agent grades on (a) leadership action visible by 30s; (b) result quantified; (c) trade-off real. (Rubric: did the senior framing land?)

- [ ] §7.2 complete

### §7.3 RIB — leadership + AI-native transformation (~20m) <!-- status: todo -->

**Objective.** This is the *current-job* story and the most osapiens-relevant — AI-native software development is a 2026 differentiator.

**Concept (story scaffold).**

- **Situation.** "At RIB Software, since Dec 2025, I'm Engineering Manager leading an international team of 6 developers on RIB's shared component library. I'm also leading multiple company-wide change projects — establishing modern, agile, agentic development practices."
- **Task.** [The specific transformation challenge — e.g., "transitioning the team from waterfall to agile in 3 months while also introducing agentic development."]
- **Action.** "Trained every team member to draft and refine specifications required for agentic development. [Specific moves: pairing junior on spec-writing, set up the AI tooling, established the HITL checkpoints, ran 15 internal knowledge-transfer workshops elsewhere.]"
- **Result.** "Agile + AI transformation in 3 months. [Quantify if you can: velocity, lead-time, defect rate, team satisfaction.]"
- **Trade-off named.** [What didn't work in the transition — be honest. AI-augmented dev has real failure modes; naming one earns trust.]
- **Hindsight.** [Earlier tooling investment? Different sequencing of training?]

**The osapiens hook.** This story signals that you can lead a team that uses AI competently — not just *do* AI-augmented work yourself. That's the rare combination osapiens (and most 2026 hirers) actually want.

**Pause for questions.** *Any questions on §7.3 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**
1. What's the timeline of the transformation (in months)?
2. What's the most concrete *user-visible* (or developer-visible) outcome you can name?
3. What's the failure mode you saw in AI-augmented dev that you'd warn osapiens about?

<details><summary>Answer key</summary>

1. **3 months** for agile + AI transformation.
2. *(no key — pick a measurable: PR cycle time, spec-to-merge time, defect escape rate, junior ramp-up time, knowledge-transfer events delivered.)*
3. *(no key — common honest answers: AI confidently produces wrong code that passes a glance review; team velocity actually drops in the first 2 sprints before climbing; spec quality becomes the bottleneck.)*
</details>

**Application question.** Tell the 90-second story. Agent grades on (a) the AI-leadership move is concrete, not buzzword-y; (b) you name a failure mode honestly; (c) you connect to "this is why I led with AI-augmented dev on the challenge code, here's how I owned the output." (Rubric: connection to the *artifact in front of them* is the closer.)

- [ ] §7.3 complete

### §7.4 The failure story (~20m) <!-- status: todo -->

**Objective.** Have one rehearsed failure story that shows reflection without throwing yourself or others under the bus.

**Concept (story scaffold).**

- **Situation.** [A real situation where something went wrong. Pick from your history. Common safe domains: a shipped bug with material impact; a hire that didn't work; a project that missed a deadline; a technical bet that didn't pay off.]
- **Task.** [What you were trying to do.]
- **Action.** [What you did — *including* the part that turned out wrong.]
- **Result.** [What happened — concretely, including the cost.]
- **Reflection.** [What you learned. *Not* "I learned to communicate better" (cliché); something specific. "I learned to ask for written sign-off on requirements that touch regulated data." "I learned that I underestimated the cost of switching ORMs mid-project."]
- **What you do differently now.** [Concrete change in your working style — observable to others.]

**Anti-patterns to avoid.**
- "My weakness is I work too hard." — caught immediately.
- Blaming the team / the boss / the customer. — even if it's true, it's interview suicide.
- "I haven't really had a failure" — the worst possible answer; signals lack of self-awareness or experience.
- Choosing a tiny failure ("I once forgot to update a comment") — signals you can't handle a real one.

**Pause for questions.** *Any questions on §7.4 before the quiz? Reply "quiz me" to proceed.*

**Recall quiz.**
1. Does your story name the *cost* of the failure concretely?
2. Does your reflection contain a specific *generalizable* lesson, not a cliché?
3. Is the "what you do differently now" something a teammate could *observe* in your working style today?

<details><summary>Answer key</summary>

1. *(no key — but vague costs sound made-up. "We had to rewrite the integration" is weak; "we lost 3 weeks of dev time and a customer renewal slipped a month" is real.)*
2. *(no key — clichés are detection markers. The lesson should be something you'd write in a runbook.)*
3. *(no key — if no, the reflection isn't real; it's just framing.)*
</details>

**Application question.** Tell the 90-second story. Agent grades on (a) cost is concrete; (b) reflection is specific not cliché; (c) the "different now" is observable. (Rubric: the lift from "I had a failure" to "I changed how I work because of it" is what they're listening for.)

- [ ] §7.4 complete

---

## §8 Mock rehearsal + gap fix (~1.5h, do **last**) <!-- status: todo -->

**Section objective.** Day-of (or day-before) sharpening. Three sub-blocks in fixed order: gap fix → quick context refresh → mock interview.

**For the AI agent.** Before starting §8, scan the **Progress Log** for any line containing `Revisit:` and collect the list of weak subsections. Surface them to the user: *"Per your progress log, the following subsections were flagged for revisit: [list]. We'll re-quiz those first."* If no revisit flags, skip §8.1 and start at §8.2.

### §8.1 Re-quiz flagged sections (~30m) <!-- status: todo -->

**Objective.** Re-quiz the recall + application questions for any subsection flagged in the Progress Log.

**Method.** Agent reads the Progress Log, picks each `Revisit:` item, jumps to that subsection, re-runs the recall quiz (without re-explaining the concept — recall first; only re-explain on misses). For the application question, the user gives a 60-second answer; agent gives concise feedback.

**Stop condition.** Either all flagged items are now confidently answered, or 30 minutes elapsed (whichever first). If items remain, log them in the Progress Log as `still-revisit:` for §8.3 mock context.

- [ ] §8.1 complete

### §8.2 Refresh the objection table from `interview/` (~15m) <!-- status: todo -->

**Objective.** Make sure the prepared defenses are top-of-mind so they're reflexive when an interviewer pushes back.

**Method.** Open the **Appendix: pushback → defense file** table at the bottom of this guide. For each row, the user re-reads the linked defense note quickly (2–3 minutes per file). Agent does *not* quiz here — this is reading-for-warm.

**Files to refresh.**
- `interview/no-lease-and-heartbeat.md`
- `interview/no-task-output-column.md`
- `interview/coroutine-vs-thread.md`
- `interview/design_decisions.md` (skim, don't read in full)

- [ ] §8.2 complete

### §8.3 Mock system-design + STAR (~45m) <!-- status: todo -->

**Objective.** One full system-design probe + two STAR stories cold. Agent plays interviewer.

**Method.**
- **(20m)** Agent picks one of: "redesign this challenge at 1000× scale" / "design a multi-tenant version" / "design the audit log for this system." User answers in the structured template (§1.6) out loud, 5-minute target. Agent grades against the rubric and probes the weakest point with one follow-up.
- **(15m)** Agent picks two STAR stories at random from §7. User tells each in 90 seconds. Agent grades on rubric.
- **(10m)** Open Q&A: user asks the agent any last question; agent answers honestly. Use this to surface anxiety, not to study new content.

**Final stop rule.** When this section completes, the guide is done. Agent should append a final entry in the Progress Log: `- YYYY-MM-DD — §8 complete. Ready for interview.`

- [ ] §8.3 complete

---

## Appendix: pushback → defense file table

The interviewer's most likely pushback phrasings, mapped to the file containing the prepared defense. Keep this table open during §8.2 and during the actual interview prep call.

| Pushback (paraphrased) | Defense file | Section in this guide |
|---|---|---|
| "Where's the lease / heartbeat? Won't a stuck task hang the queue?" | `interview/no-lease-and-heartbeat.md` | §1.3 |
| "Why isn't the output a column on `Task`?" | `interview/no-task-output-column.md` | §1.5 |
| "Why coroutines on one event loop instead of real threads?" | `interview/coroutine-vs-thread.md` | §4.2 |
| "Why default the worker pool to 1 / 3 — not N=cores?" | `interview/design_decisions.md` §Issue #17 | §1.4 |
| "What if I deploy this behind 2 load-balanced containers?" | (no file — answer cold from §1.3) | §1.3 application Q |
| "Why no retries / DLQ / circuit breaker?" | `interview/design_decisions.md` (general assumptions) | §3.4 |
| "Why no auth / authz?" | `interview/design_decisions.md` (general assumptions) | §5.2 |
| "Why SQLite, not Postgres?" | `interview/design_decisions.md` §Task 0 + §Issue #17 | §1.4 application Q |
| "Why no graceful shutdown?" | `interview/design_decisions.md` (general assumptions) | §1.3 |
| "How would this work multi-tenant?" | (no file — answer cold from §5.1) | §5.1 application Q |

**One last note.** When the interviewer pushes back, the right move is *not* to defend immediately. The right move is: **(1) restate the pushback in your own words to confirm you got it; (2) acknowledge the legitimate concern; (3) name the trade-off you made and why it was right at this scope; (4) name the production-grade alternative and what would trigger you to adopt it.** That four-beat is what separates "defensive" from "senior."