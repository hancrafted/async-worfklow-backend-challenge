# Coroutines vs Worker Threads — Study Guide

> **Audience**: someone coming from a frontend background preparing for a backend / team-lead interview. The vocabulary here (event loop, async/await, Promises) should already feel familiar; the goal is to extend that intuition into **backend concurrency**, **database write models**, and **when to reach for OS threads in Node.js**.

> **Context**: this guide explains why the [`async-workflow-backend-challenge`](../prd.md) PRD chose an in-process coroutine pool over `node:worker_threads`, and turns that decision into interview-ready talking points.

---

## TL;DR

- The workload here is **I/O-bound** (SQLite reads/writes), not CPU-bound. Async coroutines (multiple `runWorker()` loops on one event loop) already give you real I/O concurrency.
- `node:worker_threads` exist to escape **single-threaded V8 CPU bottlenecks** (image transforms, parsers, crypto, ML). There is no such bottleneck here.
- SQLite **serializes writes globally** (one writer at a time, even in WAL mode). Three threads racing on writes wouldn't run faster — they'd just produce `SQLITE_BUSY` errors.
- TypeORM's `DataSource` is **not shareable across threads** (it's a live JS object graph bound to one V8 isolate). Worker threads would each need their own `DataSource`, each opening its own SQLite handle.
- The team-lead signal is **rejecting the wrong tool with a written rationale**, not building thread plumbing for show.

---

## 1. Concurrency vs Parallelism — the distinction that breaks most frontend devs

These words are used interchangeably in casual speech but mean different things:

| Term | Definition | Frontend analogy |
|---|---|---|
| **Concurrency** | Many tasks **in progress** at the same time, possibly interleaved on one CPU. | Multiple `await fetch(...)` calls in flight from one browser tab. |
| **Parallelism** | Many tasks **physically executing** at the same time, on multiple CPU cores. | A Web Worker doing CPU work in another OS thread while the main thread renders. |

Concurrency is about **structure** ("how do I express that these things overlap?"). Parallelism is about **execution** ("are they actually running on different cores?"). You can have concurrency without parallelism (single-threaded async I/O) and parallelism without concurrency (a tight `for` loop split across cores).

**JavaScript was designed for concurrency, not parallelism.** That's why the language has `async/await` everywhere but only got `Worker` (browser) and `worker_threads` (Node) bolted on later for parallelism.

---

## 2. The Node.js event loop in 90 seconds

Node runs your JS code on **one OS thread** ("the main thread"). That thread runs an infinite loop:

```
while (true) {
  run any JS that's ready (synchronous, microtasks like resolved Promises)
  ask the OS / libuv: "any I/O finished?" (timers, file reads, network, DB)
  for each finished I/O: queue its callback
  go back to top
}
```

Key consequences:
- **JS is never preempted.** A function runs to completion (or to the next `await`) before anything else gets a turn. There's no thread that can yank the CPU away mid-statement.
- **`await` is a yield point.** When you write `await db.query(...)`, the function pauses and the event loop is free to run other code until the DB responds.
- **CPU-heavy synchronous code blocks everything.** A 2-second `for` loop doing math freezes the entire process — no requests served, no timers fired, no other coroutines progressing.
- **I/O is "free" concurrency.** While one coroutine awaits the DB, fifty others can also be awaiting their own DB calls. The OS handles them in parallel; your JS sees them all as suspended functions.

This is exactly why the PRD's "coroutine pool" works: each `runWorker()` is an `async function` that loops `claim → run → loop`. With `Promise.all([runWorker(0), runWorker(1), runWorker(2)])`, three coroutines progress concurrently — every `await` lets the others run.
---

## 3. What `node:worker_threads` actually are

A **worker thread** in Node is a real OS thread running a **separate V8 isolate**. Two important facts:

1. **Separate memory.** Each worker has its own heap. You cannot share JS objects, class instances, closures, or imported modules. Communication is via `postMessage()` using the **structured clone algorithm** — basically deep-copying serializable data across the thread boundary.
2. **Separate event loop.** Each worker has its own libuv loop. They run in parallel on multiple OS cores.

**What threads buy you:** real CPU parallelism. If you have a 2-second `crypto.scrypt()` or a 500ms image resize, offloading it to a worker thread keeps the main thread responsive and lets multiple resizes run on multiple cores simultaneously.

**What threads do *not* buy you:**
- I/O parallelism (you already have that — Node's libuv pool handles I/O concurrently).
- Database write parallelism (the DB decides that, not your threads).
- Free shared state (you have to serialize everything across the boundary).

**Cousins worth knowing:**
- `child_process` — spawns a whole separate Node process. Heavier than a worker thread, fully isolated, communicates via stdio or IPC.
- `cluster` — convenience layer that forks N copies of your Node process behind a shared listening socket. Used for HTTP servers that want to use all CPU cores.
- `Piscina` — a popular thread-pool library on top of `worker_threads`, makes it easy to dispatch CPU jobs to a pool.

---

## 4. Why coroutines win in *this* PRD — the five blockers

### Blocker 1: SQLite is a single-writer database

SQLite's concurrency model:
- **Default (rollback journal)**: one writer **and** no concurrent readers during writes.
- **WAL mode** (write-ahead log): readers don't block writers and vice versa, but **still only one writer at a time**.

Three worker threads issuing `UPDATE tasks SET status='in_progress' …` simultaneously will all hit the same write lock. Two of them get `SQLITE_BUSY` and either retry (slow) or fail (broken). You haven't gained anything — you've just moved the serialization point from "JS event loop" to "DB lock contention with retry overhead."

The right DB for true write-parallel workers is Postgres / MySQL (proper MVCC, row-level locking). That's a different challenge.

### Blocker 2: TypeORM `DataSource` is not thread-shareable

A `DataSource` is a live JS object: it holds a connection pool, an `EntityManager`, repository instances bound to entity classes via reflection metadata. None of that survives `postMessage`'s structured clone. Each worker thread would have to:

1. Import `AppDataSource` (re-running the module top-level, re-creating the pool).
2. Call `await AppDataSource.initialize()` per thread.
3. Open its own SQLite file handle → see Blocker 1.

You've gone from "one shared pool" to "N pools fighting for the same SQLite write lock."

### Blocker 3: Jobs can't cross the thread boundary as instances

Your `Job` interface is a class with a `run()` method. You can't `postMessage(new PolygonAreaJob())` to a thread — methods don't survive structured clone. The workaround is a **job registry** loaded inside each worker thread, keyed by `taskType` string. The main thread sends `{ taskType: 'polygonArea', taskId: 'xxx' }`; the worker looks up the class locally. That works, but it's now a real distributed-job-queue architecture (Sidekiq / Bull / Celery shape) — way out of scope for this challenge, and you've gained nothing for the trouble.

### Blocker 4: The workload has no CPU bottleneck

Profile the actual jobs:
- `polygonArea`: a few floating-point ops on a polygon's vertex list. Microseconds.
- `reportGeneration`: read N JSON blobs, build one bigger JSON blob. Microseconds.
- Starter `analysis` / `notification` / `email`: tiny.

Threads pay off when CPU work dominates. Here, the DB roundtrip (milliseconds) is **orders of magnitude** larger than the JS work (microseconds). Adding thread overhead (serialization, IPC, separate event loops) makes things slower.

### Blocker 5: The PRD already locked it

PRD Decision 10, line 142: *"Workers are coroutines on the same event loop, **not OS threads** — appropriate for the DB-bound + light-CPU workload here."* Reversing a locked design decision without a workload change is itself a bad signal — it suggests not understanding the original analysis.

---

## 5. What "real concurrency" looks like *in this codebase*

You already have it. The atomic-claim race is the demonstrable artifact:

```ts
// pseudo-code, runs on one event loop, three coroutines
await Promise.all([runWorker(0), runWorker(1), runWorker(2)])

async function runWorker(id: number) {
  while (!shuttingDown) {
    const claimed = await db.query(
      `UPDATE tasks SET status='in_progress'
       WHERE taskId = ? AND status='queued'`, [candidateId]
    )
    if (claimed.rowsAffected === 1) {
      await runJob(candidateId)   // <-- yields to the loop on every internal await
    }
    // try the next candidate or sleep 5s if queue empty
  }
}
```

When two coroutines target the same `taskId`, only one's `UPDATE` matches the `WHERE status='queued'` predicate; the other gets `rowsAffected=0` and moves on. **That race is real.** It's resolved at the database, atomically, exactly the same way a multi-process worker pool would resolve it.

---

## 6. Q&A — interview prep, ordered from fundamentals to gotchas

### Conceptual fundamentals

**Q: What's the difference between concurrency and parallelism?**
A: Concurrency is about **structuring** work as overlapping tasks; parallelism is about **physically executing** work on multiple CPU cores. Single-threaded async I/O (Node default) is concurrent but not parallel. A multi-core `for` loop split across cores is parallel without being concurrent (no overlapping I/O). They're often combined, but they're not the same axis.

**Q: What's a thread? What's a process?**
A: A **process** is an isolated address space with its own memory, file descriptors, and at least one thread. A **thread** is a unit of execution that shares memory with other threads inside the same process. Threads are cheaper to create and switch between than processes, and they share data without serialization — which is also why threaded code is famously bug-prone (race conditions, deadlocks, torn reads).

**Q: What's a race condition?**
A: When two units of execution access shared state without coordination, and the final result depends on **who got there first**. Classic example: two threads both read `counter = 5`, both increment to `6`, both write `6` back. The counter should be `7`. Solutions: locks, atomic operations, single-threaded designs, or pushing the coordination into a system that handles it for you (like a database row lock).

**Q: What's a deadlock?**
A: Two or more units of execution each waiting for a resource the other holds. Worker A holds lock X, wants Y; worker B holds Y, wants X. Neither can proceed. You avoid them by lock ordering, timeouts, or by avoiding shared locks entirely.

**Q: Is async code multi-threaded?**
A: No. In standard Node, all your `async` functions run on **one** main thread. The "concurrency" comes from the event loop suspending one async function at an `await` and resuming another. Underneath, **libuv** (Node's I/O library) does use a small thread pool for things like file system calls and DNS — but that's invisible to your JS code.

### Node.js / JavaScript specifics

**Q: Why is Node.js single-threaded by default?**
A: Because JavaScript itself was designed for the browser as a single-threaded language — DOM access from multiple threads would be a nightmare. Node inherited that model. The benefit: no shared-memory race conditions in your application code. The cost: any CPU-heavy synchronous work blocks everything.

**Q: What is the event loop, in one paragraph?**
A: A loop that runs your JS code, then asks the OS "any I/O finished?", queues the callbacks, and runs them next. Each `await` pauses your async function and lets the loop service other work; when the awaited operation completes, your function is queued to resume. Node's event loop has phases (timers, I/O callbacks, immediates, close handlers) and microtask queues (resolved Promises) that run between phases.

**Q: When do I reach for `worker_threads`?**
A: When CPU work dominates and is blocking the main thread. Concrete examples:
- Hashing / crypto (`bcrypt`, `scrypt`, `argon2` synchronous mode).
- Image / video transforms (Sharp, FFmpeg via N-API).
- Heavy parsing (large XML, complex regex, AST work).
- ML inference on CPU.
- Any operation you measured at >50ms of pure JS execution.

**Q: When do I reach for `cluster` / `child_process` instead?**
A: `cluster` for HTTP servers that want to use all CPU cores (each worker is a full Node process serving the same port). `child_process` for shelling out to external programs or running fully isolated subtasks where you want a clean memory boundary.

**Q: How is `worker_threads` different from a Web Worker in the browser?**
A: Conceptually identical (separate isolate, message-passing). Different APIs (`worker_threads` uses Node's `parentPort` / `MessageChannel`). Node also offers `SharedArrayBuffer` + `Atomics` for true shared memory between threads; browsers do too but with stricter security headers (COOP/COEP).

**Q: What's the libuv thread pool, and is that "real" multithreading?**
A: Libuv keeps a small pool of OS threads (default 4) used internally for file system I/O, DNS lookups, and a few crypto calls. Your JS never runs on those threads — only the C-level I/O does. So yes, your I/O is genuinely parallel under the hood; you just don't see it because your callbacks always come back to the main thread.

### Database concurrency

**Q: Why does SQLite serialize writes?**
A: It's an embedded library, not a server. The whole DB is one file. To prevent corruption, only one writer can be inside the file at a time. WAL mode improves things by letting readers continue while a write is in progress, but writes themselves are still single-file, single-writer.

**Q: How does Postgres handle concurrent writers?**
A: **MVCC** (Multi-Version Concurrency Control). Each transaction sees a consistent snapshot; writes create new row versions instead of overwriting in place. Row-level locks resolve write-write conflicts. Multiple writers genuinely run in parallel as long as they touch different rows.

**Q: What is `SELECT ... FOR UPDATE`?**
A: A row-level lock acquired during a SELECT. Other transactions trying to lock the same row block until you commit. Used to implement "claim a job" patterns in Postgres (`SELECT ... FOR UPDATE SKIP LOCKED` is the standard job-queue idiom).

**Q: How does our atomic claim work in SQLite without `FOR UPDATE`?**
A: We rely on the **conditional UPDATE pattern**: `UPDATE tasks SET status='in_progress' WHERE taskId=? AND status='queued'`. SQLite's write lock guarantees the UPDATE is atomic. If two coroutines target the same row, only one's WHERE clause matches; the other's `rowsAffected` is 0 and it moves on. Equivalent to `SELECT ... FOR UPDATE` for this use case, simpler, and works on any SQL DB.

**Q: What's `SQLITE_BUSY` and how do you handle it?**
A: Returned when a writer can't acquire the write lock within the busy timeout. Standard handling: configure a busy timeout (`PRAGMA busy_timeout = 5000`), or retry with backoff. In high-contention workloads it's a sign you've outgrown SQLite.

### This project specifically

**Q: Why does the worker pool default to N=3?**
A: Pragmatic guess that gives enough concurrency to demonstrate the atomic-claim race and pipeline a few independent tasks, while staying small enough that SQLite write contention isn't a constant problem. Configurable via `WORKER_POOL_SIZE` so reviewers can change it.

**Q: Why not N=1?**
A: With N=1, all sibling tasks serialize even when their dependencies are satisfied. A workflow with steps `[1] → [2,3,4] → [5]` would run 2, 3, 4 sequentially. With N≥2 they run concurrently. The user-visible benefit is real: shorter wallclock for branching workflows.

**Q: Why not N=10 or N=100?**
A: SQLite's writer lock caps useful concurrency. Past a few workers, additional ones spend most of their time waiting for the write lock or hitting `SQLITE_BUSY`. Empirically, 3–5 is the sweet spot for this kind of embedded-DB worker setup.

**Q: How do you ensure two workers don't run the same task?**
A: The atomic claim: `UPDATE tasks SET status='in_progress' WHERE taskId=? AND status='queued'`. The DB guarantees this UPDATE is atomic. Whichever worker's UPDATE commits first changes the status; the other's WHERE clause now fails and it moves on. No application-level locks needed.

**Q: What happens if a worker crashes mid-task?**
A: In this challenge, the DB resets on every restart (PRD line 229), so orphaned `in_progress` rows can't survive a reboot. Production-grade alternatives (heartbeat-based stale-claim recovery, `claimedAt` + sweep, distributed lock with TTL) are documented in `interview/design_decisions.md`.

**Q: What if I really wanted real parallelism for a CPU-heavy job?**
A: The right pattern: keep the coroutine pool as the orchestration layer, and offload only the CPU step inside the job to a `worker_threads` / Piscina pool. Example: a `rasterReproject` job's `run()` would `await piscinaPool.run(input)`. The orchestration stays simple, the CPU work goes parallel where it actually matters. None of that is needed here because no job has meaningful CPU work.

### Interview "gotchas" and trick questions

**Q: "Is `Promise.all` parallel?"**
A: It runs the supplied promises **concurrently** on one event loop. If the underlying work is I/O, the OS performs it in parallel for you. If the underlying work is CPU-bound JS, `Promise.all` does **not** parallelize it — every `.then` still runs sequentially on the main thread.

**Q: "How would you scale this to 10x throughput?"**
A: Profile first. If DB write contention is the bottleneck → switch DB to Postgres (or move to Redis-backed queue). If CPU is the bottleneck → introduce worker threads for the CPU step. If neither but you want geographic / fault tolerance → multi-process / multi-host with a shared queue (Redis, RabbitMQ, SQS). Don't reach for threads as a default — measure first.

**Q: "Why not Postgres?"**
A: PRD chose SQLite for setup simplicity (zero-config, fresh DB on every restart, perfect for a coding challenge harness). For a production version of this system, Postgres would be the natural upgrade — it removes the writer-lock ceiling, supports `SELECT ... FOR UPDATE SKIP LOCKED` for cleaner claim semantics, and survives crashes.

**Q: "What's the trade-off of fail-fast workflow semantics?"**
A: Pro: doomed branches don't waste compute, easier to reason about (CI-pipeline mental model). Con: you lose partial-success info — a workflow with one failed step gets no output from sibling steps that could've run. The PRD chose fail-fast because the workflows here are pipelines (downstream consumes upstream); independent-fan-out workflows would warrant a different policy.

**Q: "Show me how you'd debug a stuck workflow."**
A: Hit `GET /workflow/:id/status`. Look for tasks stuck in `in_progress` (worker hung) or `waiting` (dependency never completed). The structured JSON-line logs give you `workflowId` / `taskId` filters via `jq`. For the stuck-`in_progress` case you'd grep the worker logs for the `taskId`'s start log without a finish log.

**Q: "How would you add cancellation?"**
A: Three layers: (1) a cancellation token passed into the job, checked at every safe yield point inside `run()`. (2) DB-level: a `cancelled` task status the worker checks before each await. (3) For truly stuck jobs, wrap the job in a timeout that rejects the runner's await (the job keeps running but the worker moves on; you'd reconcile orphans on restart). The PRD explicitly skipped cancellation as out of scope (line 258).

---

## 7. Glossary (skim before the interview)

| Term | Plain-English meaning |
|---|---|
| **Coroutine** | A function that can pause (`await`) and resume later, letting other coroutines run in between. In Node, every `async function` is one. |
| **Event loop** | The infinite loop inside Node that runs your JS, waits for I/O, and runs callbacks when I/O finishes. |
| **Microtask** | A callback queued by a resolved Promise. Runs *between* event-loop phases, before the next macrotask (timer, I/O). |
| **Worker thread** | A separate OS thread running a separate V8 isolate. Used for CPU-parallel work in Node. |
| **Process** | A separate OS-level program with its own memory space. Heavier than a thread; fully isolated. |
| **MVCC** | Multi-Version Concurrency Control. How Postgres lets multiple writers coexist without locking the whole table. |
| **WAL** | Write-Ahead Log. A DB durability mechanism; in SQLite it also enables reader/writer concurrency. |
| **Race condition** | Bug where the outcome depends on which of two units of execution wins a timing race on shared state. |
| **Atomic operation** | Operation that completes as a single indivisible unit — either fully done or not at all, never half-done. SQL `UPDATE` of a single row is atomic. |
| **Idempotent** | Safe to run more than once with the same effect as running once. Critical for retry-safe code. |
| **Backpressure** | Mechanism for a slow consumer to signal a fast producer to slow down. Relevant for queues, streams. |
| **Structured clone** | The algorithm browsers / Node use to deep-copy data across thread/worker boundaries. Doesn't preserve methods, classes, or closures. |
| **`postMessage`** | The cross-thread / cross-worker communication primitive. Sends data via structured clone. |
| **CPU-bound** | Workload limited by raw compute (math, parsing, hashing). Benefits from parallelism. |
| **I/O-bound** | Workload limited by waiting on disk / network / DB. Benefits from concurrency, not parallelism. |

---

## 8. One-page cheat sheet for the interview

> "We chose an in-process coroutine pool (N=3 by default) over `worker_threads` because the workload is **I/O-bound** — every job spends its time in DB roundtrips, not CPU. SQLite serializes writes globally, so adding OS threads wouldn't increase throughput; it would just create lock contention and `SQLITE_BUSY` retries. TypeORM's `DataSource` isn't shareable across thread isolates either, so each thread would need its own connection pool fighting the same write lock. The atomic claim is implemented at the DB layer with a conditional `UPDATE` — that race is real concurrency, resolved deterministically by the database. If a future job became CPU-heavy (image transforms, heavy parsing), I'd offload only that step to `worker_threads` via Piscina, keeping the coroutine pool as the orchestration layer."

If you can deliver that paragraph cleanly in an interview, you've demonstrated:
- Workload-aware tool selection (not cargo-culting parallelism).
- Knowledge of the JS concurrency model (event loop, async, threads).
- Knowledge of DB concurrency models (single-writer SQLite, MVCC alternatives).
- Awareness of the cross-thread serialization boundary (`postMessage`, structured clone, no class instances).
- A clear evolution path (where threads would pay off).

That's the team-lead signal.
