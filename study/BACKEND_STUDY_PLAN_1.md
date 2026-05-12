# Session 1: Libuv & the Node Event Loop

**Time:** 1.5 hours
**Status:** Completed

---

## Business Use Case

Acme Wheels' procurement team uploads 200 supplier geolocation polygons at once. Each polygon triggers a `workflow_created` event. Node.js receives all 200 HTTP requests within 2 seconds. How does it process them — and in what order — without blocking?

---

## Baseline Questions & Answers

### Q1: `setTimeout(fn, 0)` inside `requestAnimationFrame` — before or after next paint?

**Answer:** After. `requestAnimationFrame` runs in the rendering phase, which sits between macrotasks. `setTimeout` lands in the timers queue of the next event loop iteration, so it fires after the paint completes.

---

### Q2: What is the microtask queue? Does `Promise.resolve().then()` enter the same queue as `setTimeout`?

**Answer:** Microtasks (Promise callbacks) run after the current call stack exhausts, but before the next macrotask. `Promise.resolve().then()` does NOT enter the same queue as `setTimeout` — they are separate queues with different priorities. Microtasks have higher priority.

Phase order: `call stack → microtasks → [render] → next macrotask (e.g. setTimeout)`

---

### Q3: In `fetch()`, which browser component initiates the request — and which OS syscall fires?

**Answer:** JavaScript engine (V8) initiates `fetch()`, then the Web API takes over. The Web API calls the OS via Berkeley sockets (macOS/Linux) or WinHTTP (Windows). On macOS/Linux the syscall is `connect()` on a socket file descriptor.

In Node, libuv wraps these OS-level calls with a cross-platform API — this is exactly where libuv sits.

---

### Q4: What does "event loop blocking" mean in a browser context? What pattern causes dropped frames?

**Answer:** Synchronous long-running code holds the call stack and prevents the event loop from processing the next task, rendering, or any other phase — causing dropped frames (jank). Single-threaded JS is the root cause.

---

### Q5: Do you know what libuv is?

**Answer:** No prior knowledge. This session filled that gap.

---

## Key Concepts Covered

### What is libuv?

libuv (Unix Virtual) is the C library Node.js uses to implement the event loop and async I/O. Key responsibilities:

1. **Event loop implementation** — the phase-based loop
2. **Thread pool** — async file I/O, DNS lookups, crypto operations run here
3. **Cross-platform I/O** — wraps macOS/Windows/Linux I/O APIs

### The Thread Pool — Critical Addition vs Browser

In the browser, network I/O is delegated to the OS. In Node, libuv provides a **thread pool** for operations the OS doesn't expose async for.

| Operation | Where it runs |
|---|---|
| `fs.readFile()` | Thread pool (libuv) |
| `fs.writeFile()` | Thread pool (libuv) |
| `DNS.lookup()` | Thread pool (libuv) |
| `crypto.pbkdf2()` | Thread pool (libuv) |
| `setTimeout()` | Event loop (no thread) |
| `setImmediate()` | Event loop (no thread) |
| HTTP requests | OS async (no thread) |

`UV_THREADPOOL_SIZE` defaults to **4 threads**. Each thread has ~1MB stack cost. Max is 1024.

### CPU Core vs Thread — A Fundamental Distinction

**CPU core** = physical execution unit on the processor chip. Can execute one instruction stream at a time.

**Thread** = an execution context managed by the OS scheduler. One core can rapidly switch between threads (time-slice multitasking), giving the illusion of parallelism.

```
Single core, time-slice multitasking:
|t1 start|t1 end| t2 start|t2 end| t3 start|t3 end|
|<-- 1ms -->|<-- 1ms -->|<-- 1ms -->|
All three threads appear simultaneous — but core runs one at a time
```

**Multi-core CPU**: Has multiple physical execution units. Two threads can run **truly in parallel** on two different cores simultaneously.

### Why this matters for `UV_THREADPOOL_SIZE`

The libuv thread pool creates **OS threads for I/O waiting** — not CPU computation threads. These threads are blocked on disk/network syscalls. The CPU core running your JS is free to do other work while these threads wait.

**The threads are not doing CPU work** — they're waiting for I/O. More threads = more concurrent I/O operations in flight, not faster computation.

| Work type | What you need |
|---|---|
| **I/O-bound** (file reads, API calls) | More threads in pool — threads wait, CPU is free |
| **CPU-bound** (polygon math, encryption) | More CPU cores + worker_threads — need actual parallel computation |

**Important**: Increasing `UV_THREADPOOL_SIZE` does NOT help CPU-bound work. Increasing CPU cores does NOT help I/O-bound work. These are different bottlenecks with different solutions.

### In-Flight Operations

**"In-flight"** = an operation has been started but not yet completed. Data is "in flight" — sent, but response hasn't returned.

**Step by step — reading 2 files with `UV_THREADPOOL_SIZE=4`:**

```
T=0: fs.readFile('file1') + fs.readFile('file2') called
     Main thread dispatches both to thread pool
     Thread 1: reading file1... (in-flight, waiting)
     Thread 2: reading file2... (in-flight, waiting)
     Thread 3-4: idle
     Main JS thread is FREE — not blocked

T=3: Disk finishes file1 → callback fires in event loop
T=4: Disk finishes file2 → callback fires in event loop
```

**"In-flight" at T=1**: both reads have been initiated, neither has completed. 2 concurrent I/O operations using 2 of 4 available threads.

### How disk I/O actually works (DMA)

When `fs.readFile()` runs:
```
1. CPU copies data from kernel buffer → user buffer (fast, CPU work)
2. DMA engine reads from disk hardware (hardware does this, CPU is free)
3. OS handles completion interrupt → libuv posts callback to event loop
4. Event loop fires your JS callback
```

The **actual disk read** (bits moving through disk controller to flash/platters) is done by the disk's DMA engine, not the CPU. The CPU is only involved at setup and completion. This is why many disk I/O operations can be in-flight simultaneously without exhausting the CPU.

---

### How thread pool concurrency works

JavaScript is single-threaded — your code never runs on multiple threads simultaneously. When you call `fs.readFile()`, Node passes the operation to a worker thread from the pool. The worker does the blocking syscall. When it completes, it posts a callback to the main event loop queue.

```
Main thread (JS)                    Thread Pool (4 threads)
─────────────────                   ───────────────────────
fs.readFile() ──► dispatch ──► [thread 1: doing read()    ]
                                 [thread 2: doing read()    ]
                                 [thread 3: doing read()    ]
                                 [thread 4: doing read()    ]
                                                    ↕ syscall completes
                                           callback queued in event loop
                                                    ↕
                                         [event loop fires callback]
```

### Event Loop Phases (libuv order)

```
timers ──────────► pending callbacks ──────────► idle/prepare ──────────► poll ──────────► check ──────────► close callbacks
(setTimeout)      (deferred I/O errors)         (internal)              (I/O callbacks)  (setImmediate)  (socket close)
```

- **timers**: `setTimeout`, `setInterval` callbacks
- **pending callbacks**: deferred I/O errors from previous phase
- **idle/prepare**: internal libuv housekeeping
- **poll**: executes I/O callbacks; waits for incoming I/O if queue is empty
- **check**: `setImmediate` callbacks run here — this is where `setImmediate` fires
- **close callbacks**: `socket.on('close')` handlers, resource cleanup

`setTimeout(fn, 0)` fires in timers phase. `setImmediate` fires in check phase. Ordering between them is **not guaranteed** unless I/O is involved — if I/O is pending, `setImmediate` typically fires first because the poll phase immediately transitions to check.

### The nextTick Queue

`process.nextTick()` has its own queue that drains **before any event loop phase advances**. It runs even before microtasks:

```
[current operation finishes] → nextTick queue drains → microtasks drain → [only then does the event loop advance to the next phase]
```

**No browser equivalent.** `process.nextTick` can starve the event loop if overused.

### Why process.nextTick() exists

Added to Node before Promises existed — as a **compatibility and async-safety mechanism**:
1. **Ensuring async behavior** for early Node callback-based APIs — guaranteed callbacks ran asynchronously without going through the full event loop
2. **Recursion prevention** — allows synchronous recursive calls to defer to the next event loop iteration, avoiding stack overflow

Today, with Promises and `async/await`, you rarely need it. But it remains for backward compatibility.

**Dangers of overusing:**
- **Starvation**: Can block event loop from advancing — if callbacks keep adding to the `nextTick` queue, no I/O, timers, or other phases ever run
- **Debugging confusion**: Stack traces are misleading because `nextTick` callbacks run before any I/O phase
- **Microtask ordering surprise**: `process.nextTick` runs before `Promise.then()` — if you expect microtasks first, you'd be wrong

### Microtask placement in Node

Microtasks (Promises) run between phases, after `process.nextTick`:

```
[current operation finishes]
  → process.nextTick queue drains completely
  → Microtask queue (Promises) drains completely
  → [only then does the event loop advance to the next phase]
```

### setImmediate vs setTimeout ordering

```js
setTimeout(() => console.log('timeout'), 0)
setImmediate(() => console.log('immediate'))
```

Usually `setTimeout` fires first (timers phase vs check phase), but if I/O is pending, `setImmediate` can fire first. Ordering is **not guaranteed** without I/O.

---

## Design Decision Discussion: CPU vs I/O Bound Services

### The Core Question: CPU or I/O bound?

The first architectural decision for any service processing 500 compliance documents:

> "Is processing each document CPU-bound or I/O-bound?"

This gates every other architectural decision.

### CPU-bound Services

Processing involves computation (polygon area calculations, PDF generation, image processing).

**Strategies:**
- **worker_threads** — spread CPU work across multiple threads within one process
- **SharedArrayBuffer** — for numerical data (matrices, image bytes), avoids structured clone overhead
- **Horizontal scaling** — multiple processes, each processing one document, coordinated via queue

**SharedArrayBuffer deep dive:**
- Fixed-size raw byte buffer both threads share — no copying
- Requires `Atomics` for coordination — without it, data races cause silent corruption
- Practical for: image processing, matrix math, polygon area calculations
- Not practical for: JSON/objects (requires serialization anyway), first-time implementation

### I/O-bound Services

Processing involves network calls, external API calls, database writes.

**Strategies:**
- **Async patterns** — event loop handles waiting efficiently, no blocking
- **Increase `UV_THREADPOOL_SIZE`** — if file I/O is a bottleneck (default 4 is often too small)
- **Queue backpressure** — protect workers from memory exhaustion during bursts

### Horizontal Scaling vs worker_threads

| Approach | When to use |
|---|---|
| **worker_threads** (vertical) | One machine, CPU-bound work, low latency, bounded workload |
| **Horizontal scaling** (multiple processes) | Fault tolerance needed, unbounded scale, production compliance systems |

For osapiens cloud-native stack: horizontal scaling with persistent queue (Redis/BullMQ) is the standard approach.

---

## Interview Framing: Designing a Document Processing Service

### Questions to ask (calibration before designing)

1. **"What is the average and max size of each document?"** — CSV vs PDF vs GeoJSON are completely different workloads
2. **"Is processing CPU-bound or I/O-bound?"** — gates everything
3. **"Do documents have dependencies or can they be processed independently?"** — affects parallelism strategy
4. **"What's the SLA per document — seconds, minutes, hours?"** — tells you whether you need parallelism
5. **"What happens if processing fails mid-document — retried or dead-lettered?"** — error boundary design
6. **"Is this a steady state of 500/day or a burst arriving in 2 seconds?"** — thundering herd problem

### Tradeoffs to voice early

- **"500 concurrent HTTP requests is a thundering herd"** — better to enqueue only, not process synchronously
- **"I need to know the memory footprint per document"** — 500 × 50MB = 25GB, cannot hold in V8 heap, need streaming
- **"If processing is CPU-bound, the event loop is my enemy"** — need worker_threads or horizontal scale
- **"If I use worker_threads with large data, structured clone becomes a bottleneck"** — consider SharedArrayBuffer for numerical data

### The one-liner to remember

> "I need to know whether each document's processing blocks the event loop — if it's CPU-bound I need worker threads, if it's I/O-bound I need to manage the thread pool size and queue backpressure."

---

### Architecture Decision: Queue vs Load Balancer

For 500 documents arriving in a 2-second burst — a **queue-based approach** (Redis/BullMQ) is correct. A load balancer is premature unless you have multiple machines distributing load across them.

```
HTTP Endpoint (enqueue only, return 202 Accepted)
        ↓
BullMQ Queue (Redis)
        ↓
Worker Pool (Node.js processes, one per CPU core)
  ├─ Worker 1: picks job → worker_threads for CPU-bound polygon calc → writes to ScyllaDB
  ├─ Worker 2: same
  └─ Worker N: same

Each worker uses worker_threads internally so CPU-bound polygon calculations
don't block the event loop. BullMQ prefetch limits prevent workers from
claiming too many jobs at once (backpressure at consumer level).
```

**Key insight**: `worker_threads` solves CPU-bound event loop blocking within each worker. BullMQ + horizontal scaling (multiple Node.js processes) solves fault tolerance and scale. These are complementary, not alternatives.

---

## Local Development & Testing

### Infrastructure for local development

Docker Compose runs single-node infrastructure locally:

```yaml
# docker-compose.yml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
  scylladb:
    image: scylladb/scylla:5.2
    ports:
      - "9042:9042"
```

Workers connect to Redis — BullMQ ensures jobs are distributed across workers:

```bash
docker compose up           # Start infra
node dist/worker-1.js &     # Worker 1
node dist/worker-2.js &     # Worker 2
node dist/worker-3.js &     # Worker 3
npm run dev                 # Feature-service
```

### Integration test stack

| Category | Tool | Purpose |
|---|---|---|
| **Test runner** | Vitest | Runs tests, parallel execution |
| **Container orchestration** | Testcontainers | Spins up real Redis, ScyllaDB in tests |
| **HTTP client** | Supertest/Fetch | Tests HTTP endpoints |
| **Queue client** | bullmq (native) | Enqueues jobs, reads job state |
| **DB client** | scylladb-driver | Direct DB queries for state verification |

### DB as authoritative source

Querying the DB is the **authoritative** way to verify state, but not the only way:

| Method | What it verifies | When to use |
|---|---|---|
| **Query DB** | "Did data write correctly?" | Final state verification |
| **Read from queue** | "Did job complete/fail/retry?" | Queue behavior tests |
| **HTTP response** | "Does API return correct status?" | Contract tests |
| **Logs/metrics** | "Did job run and in what time?" | Performance tests |

### Testing pattern for workers

```ts
// test/helpers/waitForJob.ts
export async function waitForJobCompletion(jobId: string, queue: Queue, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId)
    if (job?.finished) return job
    if (job?.failed) throw new Error(`Job failed: ${job.failedReason}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Job did not complete within ${timeout}ms`)
}
```

No `setTimeout` sleeping in tests — use proper wait helpers with timeouts.

---

## Resources

- libuv documentation
- "The Node.js Event Loop" by Luis Herrera (freeCodeCamp)
- BullMQ documentation
- "Designing Data-Intensive Applications" by Martin Kleppmann — Chapters 1-5
- Testcontainers for Node.js

---

## Quiz Summary — Session 1

**Overall: Solid foundational understanding.** Demonstrated genuine intuition for distributed systems tradeoffs, not just memorized facts.

### Strong Areas
- Event loop phases: Core structure correct. Knew `process.nextTick` drains before microtasks and `setImmediate` runs in check phase. Minor gap: missed `pending callbacks` and `idle/prepare` phases.
- Diagnosing slow I/O: Correctly identified CPU vs I/O distinction, decoupled processing stages, proposed streaming and queue-based backpressure.
- Thread pool operations: Knew exactly which ops use thread pool and which don't. Named `DNS.lookup` and `crypto` as examples. Clean.

### Areas to Strengthen
- **`process.nextTick` rationale**: Correctly identified starvation danger but didn't know original purpose (early Node compatibility before Promises existed). Knowing historical reason demonstrates depth.
- **Worker pool design**: Good questions (file size, ordering, validation). Reached for load balancer prematurely — 500 burst requests don't need a load balancer. Also missed: **worker_threads for CPU-bound polygon calculations** — this is critical for that scenario.
- **Thread pool sizing misconception**: Mixed up "more CPU cores" with "more threads." Threads in libuv pool are I/O wait threads, not CPU workers. Increasing `UV_THREADPOOL_SIZE` helps when disk can handle concurrency (SSDs), but doesn't help CPU-bound work at all.

### The One Thing to Drill

> **"CPU-bound work blocks the event loop — worker_threads solve this by running computation in a separate V8 isolate. The thread pool only helps with I/O-bound work."**

If you can say this clearly with a concrete example (polygon calculations in a compliance processor), you'll pass the technical bar on this topic.

---

*Session 1 completed. Next: Session 2 — V8 Internals: JIT, Deoptimization & GC Pressure*