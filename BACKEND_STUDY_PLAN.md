# Backend Study Plan — osapiens Team Lead Interview

**Time budget:** ~8–10 hours
**Goal:** Demonstrate the same depth for Node.js backends that you have for browser/V8 frontends

---

## Context & Purpose

**Company:** osapiens — ESG software platform (osapiens HUB) with a sovereign European cloud.

**Team:** Business Partner Transparency (BPT) Unit — responsible for supply chain transparency compliance. ESG regulations like CSRD, EUDR, and CSDDD require companies to collect, verify, and disclose supplier data across Tier 1–3 of their supply chain.

**Role:** Full-stack team lead with frontend origins, joining a backend-focused team. The team develops features that workers can pick up and execute at scale — document processing, compliance report generation, customer-configured workflows, and notifications. The engineering stack is Java/Spring (core worker platform), Node.js + TypeScript (feature-services), ScyllaDB/Cassandra (distributed data), GraphQL + REST (APIs).

**Problem being solved:** You have deep browser/V8 knowledge (critical rendering path, CSS animation performance, JavaScript engine optimization). You need equivalent depth for Node.js backends to lead architecture discussions, pass the technical bar, and demonstrate that your frontend origins are not a limitation.

**Existing strengths to leverage:** Browser event loop, V8 internals (hidden classes, GC, deoptimization), critical path analysis, WebSocket conceptionally.

---

## Core Items (invest real time)

### 1. Libuv & the Node Event Loop
**Time:** ~1.5h
**Status:** ✅ Completed
**Session notes:** `study/BACKEND_STUDY_PLAN_1.md`
**Why it matters:** You already know the browser event loop. This maps that model to libuv's thread pool, `nextTick` queue, `setImmediate` queue, and how async I/O (fs, DNS, crypto) actually schedules. Critical for understanding how a worker pool dispatches jobs without blocking.

**What to study:**
- How `setTimeout`, `fs.readFile`, and `process.nextTick` schedule differently
- libuv's thread pool size (`UV_THREADPOOL_SIZE`, default 4, max 1024) — async file I/O and DNS share this pool
- `setImmediate` vs `process.nextTick` ordering guarantees
- Phase order: poll → check → timers → then repeat

**Resources:** libuv documentation, "The Node.js Event Loop" by Luis Herrera (freecodecamp)

---

### 2. V8 Internals: JIT, Deoptimization & GC Pressure
**Time:** ~1.5h
**Status:** ✅ Completed
**Session notes:** `study/BACKEND_STUDY_PLAN_2.md`
**Why it matters:** Long-running worker services hit GC pauses and deoptimization in ways short-lived scripts don't. You need to recognize when your code is causing V8 to give up on an optimization — and why that matters for latency.

**What to study:**
- JIT compilation tiers: interpreter → baseline compiler (Sparkplug) → optimizing compiler (TurboFan)
- Hidden classes and inline caching — same concept as browser V8
- Deoptimization triggers: polymorphic vs. megamorphic call sites, try/catch interference with inlining
- GC pause impact: scavenge (young gen), mark-sweep, mark-compact (old gen); when pause times become noticeable
- `--max-old-space-size` and how it interacts with promotion

**Resources:** V8 blog (v8.dev/blog), "Understanding V8's JIT Compiler" by Jason Miller (Web.dev)

---

### 3. Async Error Handling & Error Propagation
**Time:** ~1h
**Status:** ✅ Completed
**Session notes:** `study/BACKEND_STUDY_PLAN_3.md`
**Why it matters:** In a distributed worker system, errors must propagate correctly across async boundaries — otherwise jobs silently fail and the system appears to hang. The error boundary model differs fundamentally from synchronous stack traces.

**What to study:**
- `Promise` rejection paths: unhandled vs. caught
- `process.on('unhandledRejection')` — what it captures, when it fires
- `process.on('uncaughtException')` — last-resort handler, how it differs from rejection handlers
- Async error propagation: throwing inside an async function vs. rejecting a Promise; which gets caught where
- Error boundary patterns in worker dispatch: try/catch around `await`, wrapping with `.catch()`

**Resources:** Node.js docs on `process` events, "Error Handling in Node.js" by Joe Nash (YouTube)

---

### 4. Stream Backpressure in Node
**Time:** ~1h
**Why it matters:** Supplier data ingestion or report generation can produce large intermediate results. Without backpressure, a CPU-bound worker can consume an unbounded amount of memory or silently block the event loop.

**What to study:**
- `highWaterMark` — the internal buffer limit before `write()` returns false
- How `pipe()` handles backpressure: when the readable's internal buffer fills, it stops pulling from the source
- Manual backpressure: checking `write()` return value, using `drain` event
- What happens when you ignore backpressure: memory growth, event loop starvation
- Contrast with browser: backpressure in Streams API is conceptually identical

**Resources:** Node.js Streams documentation, "Stream Handbook" by @substack

---

### 5. Memory Management & Heap Limits
**Time:** ~1h
**Status:** ✅ Completed
**Session notes:** `study/BACKEND_STUDY_PLAN_5.md`
**Why it matters:** Long-running workers with large compliance datasets will hit V8's heap limit if you're not careful. Knowing the difference between "V8 throws" and "OS OOM killer fires" is operationally critical.

**What to study:**
- V8 heap generations: young (scavenge), old (mark-sweep/compact), large object space
- `--max-old-space-size` flag — setting the heap cap
- `process.memoryUsage()` — `heapUsed` vs `heapTotal` vs `external`
- What happens at heap limit: V8 throws `RangeError: Invalid array length` or similar; how to catch and handle
- When the OS OOM killer fires: V8 can't prevent it; Linux `dmesg` shows `oom-killer` entries
- Memory leaks in Node: common causes (global caches, event listener buildup, closure captures)

**Resources:** Node.js docs `process.memoryUsage()`, "Tracking Down Memory Leaks in Node.js" by Dave Whittington

---

### 6. `worker_threads` & Structured Cloning
**Time:** ~1h
**Status:** ✅ Completed
**Session notes:** `study/BACKEND_STUDY_PLAN_6.md`
**Why it matters:** If you ever need to offload CPU-bound work (polygon area calculations, PDF generation, image processing), `worker_threads` is Node's answer to multi-core utilization. Understanding structured cloning prevents subtle data corruption bugs.

**What to study:**
- `new Worker()` — creating an isolated JavaScript context
- `workerData` — passing data in; structured clone algorithm (what survives, what doesn't: no functions, no circular refs, Symbols lost)
- `MessageChannel` and `postMessage()` — two-way communication between threads
- `parentPort` — how the main thread and worker communicate bidirectionally
- Shared memory (`SharedArrayBuffer`) — the escape hatch for high-throughput data passing
- Contrast with `cluster` module: cluster forks processes ( IPC + shared sockets), worker_threads shares memory via structured clone

**Resources:** Node.js `worker_threads` documentation, "Using Worker Threads in Node.js" on the Node.js blog

---

## Awareness Items (1–2h total — enough to ask good questions)

### 7. Distributed NoSQL Consistency (ScyllaDB/Cassandra)
**Time:** ~30–45m
**Status:** ✅ Completed
**Session notes:** `study/BACKEND_STUDY_PLAN_SUMMARY_7.md`
**Why it matters:** Your data will be partitioned across a distributed NoSQL cluster. Partition key decisions are irreversible. You need to hold your own in data modeling discussions.

**What to know:**
- Partition key: determines which node holds your data; hot partitions are a real problem
- Clustering key: determines sort order within a partition
- Eventual consistency: reads may return stale data after a write; how Cassandra/ScyllaDB handles this
- Linearizability: the strongest consistency model; tradeoffs with availability (CAP theorem)
- Read repair vs. anti-entropy: how the cluster heals inconsistencies over time
- Lightweight transactions (LWT) in Cassandra: linearizable consistency at a cost

**What NOT to study deeply:** CQL syntax, driver integration — that's Java team territory

---

### 8. Message Queue Backpressure Patterns
**Time:** ~30m
**Status:** ✅ Completed
**Session notes:** `study/BACKEND_STUDY_PLAN_SUMMARY_8.md`
**Why it matters:** Jobs like "generate compliance report" or "send notification" are queued workers. Understanding prefetch, retry, and dead-letter semantics helps you design reliable job chains.

**What to know:**
- Prefetch count: how many jobs a consumer claims before acking; too high = memory pressure, too low = throughput loss
- Retry with exponential backoff: how the queue re-delivers failed jobs
- Dead-letter queue (DLQ): jobs that exceed retry limits; where they go and how to inspect them
- Backpressure at the broker: when consumers are slow, the broker slows producers automatically
- Contrast with Node stream backpressure: broker-layer vs. in-process flow control

---

### 9. Event Loop Lag & Profiling
**Time:** ~30m
**Status:** ✅ Completed
**Session notes:** `study/BACKEND_STUDY_PLAN_SUMMARY_9.md`
**Why it matters:** When a worker appears to hang, it's usually event loop starvation. You need to be able to prove it with data.

**What to know:**
- Event loop lag: time between when something is scheduled and when it executes
- `perf_hooks` — `performance.eventLoopUtilization()`, `performance.nodeTiming`
- `node --prof` — profiling flag, produces tick logs; use `node --prof-process` to view
- v8 profiler in Chrome DevTools: attach to running Node process, capture CPU flamegraph
- Reading a flamegraph: which functions consume the most CPU time
- Structured JSON logging (the system already uses this): how to query logs for lag indicators

---

### 10. GraphQL Subscriptions & WebSocket
**Time:** ~30–45m
**Status:** ✅ Completed
**Session notes:** `study/BACKEND_STUDY_PLAN_SUMMARY_10.md`
**Why it matters:** Concepually you know WebSocket; close the gap on server-side pub/sub so you can implement real-time job status updates.

**What to know:**
- WebSocket lifecycle: connect → upgrade → bidirectional frames → close
- How GraphQL subscriptions use WebSocket under the transport-agnostic `graphql-ws` or `subscriptions-transport-ws` protocols
- Pub/sub model: single broadcaster → multiple subscribers; Redis or in-memory as backing store
- Backpressure in subscriptions: client disconnects are asynchronous; how to handle fast producer / slow consumer
- Difference from polling: tradeoffs of streaming vs. polling for job status updates

---

## Time Budget Summary

| # | Topic | Time |
|---|-------|------|
| 1 | Libuv & Event Loop | 1.5h |
| 2 | V8 Internals & GC | 1.5h |
| 3 | Async Error Handling | 1h |
| 4 | Stream Backpressure | 1h |
| 5 | Memory & Heap Limits | 1h |
| 6 | worker_threads | 1h |
| 7 | NoSQL Consistency (awareness) | 45m |
| 8 | Message Queue Patterns (awareness) | 30m |
| 9 | Profiling & Event Loop Lag (awareness) | 30m |
| 10 | GraphQL Subscriptions & WebSocket (awareness) | 45m |
| | **Total** | **~9h 45m** |

## How to Use This Plan

1. Start with **Item 1 (Libuv)** — it anchors everything else and benefits most from your browser event loop knowledge
2. Do **Items 2–3** next — they build on each other and are interview-critical
3. Do **Items 4–6** in any order — they address CPU-bound worker concerns directly
4. Spread **Items 7–10** across remaining time — do them in any order based on what comes up in conversation

## For the Interview

- When asked about worker pool design: reference **Items 1, 4, 5** — event loop safety, backpressure, memory bounds
- When asked about V8 performance: reference **Item 2** — deoptimization triggers and GC pauses
- When asked about distributed data: reference **Item 7** — partition key awareness
- When asked about reliability: reference **Items 3, 8** — error propagation and queue fault tolerance
- When asked about profiling: reference **Item 9** — event loop lag as the key metric

*Created from "grill-me" interview session. Domain context: osapiens BPT unit, Node.js feature-services in front of Java/Spring worker core, ScyllaDB/Cassandra, GraphQL + REST API.*

---

## How to Study

### How this works

This section describes how each topic is studied. For each of the 10 items, the session follows the same structure:

1. **Business use case** — a concrete customer scenario or compliance requirement that makes the topic feel real, not abstract
2. **Baseline questions** — 3–5 specific questions to identify what you already know and where to focus study time
3. **Concept introduction** — the topic explained as if to a senior frontend engineer who is also a junior backend architect; frontend analogies used where they help, but differences called out precisely
4. **Confirmation gate** — "Any questions before we move on?" before proceeding to the next topic

Study sessions run topic by topic. Each topic assumes you've completed the prior one. Start with Item 1 (Libuv) — it establishes the foundational mental model everything else builds on.

---

### Section-level business use case

> A mid-sized manufacturing company ("Acme Wheels", fictitious) is subject to the EU Deforestation Regulation (EUDR). They must prove that the rubber used in their bicycle tires came from suppliers that did not clear forest land after December 2024. Acme Wheels' procurement team uploads supplier data — including geolocation polygons of farms — through the osapiens HUB. Each polygon triggers an async workflow: area calculation → risk scoring → compliance report generation. The compliance officer wants real-time progress on the dashboard while hundreds of supplier submissions queue up. Your Node.js feature-service must handle this without blocking the event loop, exhausting memory, or losing jobs on worker crash.

---

### Per-topic subsections

#### Item 1: Libuv & the Node Event Loop

**Time budget:** 1.5 hours

**Business use case:** Acme Wheels' procurement team uploads 200 supplier geolocation polygons at once. Each polygon triggers a `workflow_created` event. Your Node.js service receives all 200 HTTP requests within 2 seconds. How does Node process them — and in what order — without blocking?

**Baseline questions (answer before studying):**

1. In the browser, what happens to `setTimeout(fn, 0)` when called from inside a `requestAnimationFrame` callback? Does it run before or after the next paint?
2. What is the browser's "microtask queue"? Does `Promise.resolve().then()` enter the same queue as `setTimeout`?
3. When you call `fetch('/api/data')` in a browser, which browser engine component initiates the network request — and which OS-level system call fires?
4. What does "event loop blocking" mean in a browser context? What JavaScript pattern causes the browser to drop frames?
5. Do you know what libuv is, or have you only encountered it by name in Node.js error messages?

**Frontend analogy:** The browser event loop you know well — microtasks, macrotasks, `requestAnimationFrame`, the rendering pipeline — is the starting point. libuv (short for "Unix Virtual") is the underlying C library that implements the same contract on the server side, but it adds a thread pool for file I/O that the browser doesn't have (the browser delegates network I/O to the OS). The analogy holds for scheduling, but diverges on I/O concurrency.

**Key differences from the browser:**
- The browser has one thread for JavaScript + rendering. Node has one JavaScript thread and a separate thread pool for I/O.
- `process.nextTick()` is Node-specific and runs before any other phase — there is no browser equivalent.
- `setImmediate()` (Node) runs in the "check" phase, which happens after the "poll" phase — but the browser has nothing equivalent; it runs as a macrotask after the current stack is exhausted.

---

**Confirmation gate:** Do you have any questions about the event loop phases or libuv's thread pool before we move to V8 internals?

---

#### Item 2: V8 Internals: JIT, Deoptimization & GC Pressure

**Time budget:** 1.5 hours

**Business use case:** The compliance report generator processes a batch of 500 supplier polygons. Each polygon area calculation runs in a tight loop calling `@turf/area`. After about 150 processed polygons, the operation mysteriously slows down. The profiler shows a massive spike. What happened in V8 — and how would you prevent it?

**Baseline questions (answer before studying):**

1. In the browser V8 engine, what is a "hidden class"? How does it make property access faster than a plain object lookup?
2. What does "deoptimization" mean in V8? Can you describe a scenario where V8 stops using an optimized function and falls back to slower code?
3. What triggers a garbage collection (GC) pause in the browser? Have you ever noticed it as a "jank" moment?
4. Does the browser V8 engine have a heap size limit? What happens if you try to allocate beyond it?
5. In your browser V8 knowledge, what is "inline caching"? Where does it apply?

**Frontend analogy:** Your V8 knowledge from the browser — hidden classes, inline caching, Turbofan, deoptimization — transfers almost directly. V8 is V8 whether it runs in Chrome or Node. The differences are operational: in the browser you observe GC pauses as jank; in Node you observe them as latency spikes on API responses. The heap management model is identical.

**Key differences from the browser:**
- Long-running Node processes (hours/days) accumulate heap differently than a browser tab (minutes/hours). GC promotion from young to old generation happens at scale the browser rarely reaches.
- In Node, you can set `--max-old-space-size` to cap the heap — there is no browser user setting equivalent.
- Node can encounter native memory pressure (outside the V8 heap) via addons or `SharedArrayBuffer` — the browser sandbox prevents this.
- Production Node apps often run multiple V8 isolates (via `cluster` module) sharing one process — each isolate has its own heap; in the browser you have one tab one heap.

---

**Confirmation gate:** Any questions on deoptimization triggers or GC phases before we move to async error handling?

---

#### Item 3: Async Error Handling & Error Propagation

**Time budget:** 1 hour

**Business use case:** Acme Wheels' supplier data ingestion service calls an external validation API to verify polygon coordinates. The external API is down — it returns a 503 after 30 seconds. The calling function is inside a worker pool handler. The error must propagate correctly: the job should be marked as failed, a retry scheduled, and the compliance dashboard updated — not silently swallowed.

**Baseline questions (answer before studying):**

1. In the browser, what happens if you `throw` inside a `Promise.then()` callback without a `.catch()`? Does an uncaught exception dialog appear in Chrome DevTools?
2. In the browser, what is the `window.onerror` handler — and how does it differ from `window.addEventListener('error', ...)`?
3. Have you ever seen the Node.js warning: `UnhandledPromiseRejectionWarning: Promise rejection was treated as an error`? What did you do to fix it?
4. In a browser async function, if you `throw new Error('oops')` inside a `try/catch` that wraps an `await`, does the catch block receive it? What about a rejected Promise that's not awaited?
5. What is the difference between a "handled" and an "unhandled" Promise rejection in Node?

**Frontend analogy:** Error handling in the browser is about `try/catch`, `window.onerror`, and `unhandledrejection` events. The same patterns exist in Node, but the async nature of Node makes the failure modes different. In the browser you can see synchronous stack traces in DevTools; in Node you often get a `stack` that ends in an async boundary with no visible caller.

**Key differences from the browser:**
- Node's `process.on('unhandledRejection')` fires for uncaught rejections at the process level — there is no browser equivalent that fires process-wide.
- Node's `process.on('uncaughtException')` catches synchronous errors in the top-level scope — there is no browser equivalent because code doesn't run at the top level in a browser.
- In Node, errors thrown inside a `Promise.then()` callback (not awaited) may produce a silent unhandled rejection if no `.catch()` is attached — in the browser this would eventually surface in DevTools.

---

**Confirmation gate:** Any questions on how error boundaries differ between Node and the browser before we move to streams?

---

#### Item 4: Stream Backpressure in Node

**Time budget:** 1 hour

**Business use case:** A compliance auditor exports a full supplier dataset as a CSV. The dataset is large — 50,000 rows from a ScyllaDB query, processed row by row and written to an HTTP response stream. The database query returns data faster than the HTTP connection can send it. Without backpressure, your Node process accumulates an ever-growing buffer in memory. At what point does this become a problem — and how does backpressure prevent it?

**Baseline questions (answer before studying):**

1. In the browser, what is the Fetch API's `ReadableStream` body? Have you used `response.body.getReader()` and called `.read()` in a loop?
2. What does it mean for a stream to be "backpressured"? Can you describe a scenario in browser-side streaming where backpressure matters?
3. In a browser, if you have a `ReadableStream` feeding into a `WritableStream` via `.pipeTo()`, does the browser manage flow control automatically, or do you have to manage it?
4. What is `highWaterMark` in the context of streams? Have you encountered it in browser or Node APIs?
5. In the browser Streams API, what does `.tee()` do — and why might it matter for backpressure?

**Frontend analogy:** The browser Streams API (introduced in 2018) has backpressure semantics that are nearly identical to Node's. If you've used `ReadableStream.pipeTo()` or `ReadableStream.getReader()`, you already know the concept. The key difference is that Node exposes `highWaterMark` and `write()` return values explicitly, while the browser abstracts some of this away.

**Key differences from the browser:**
- Node exposes backpressure mechanics explicitly (`write()` returns `false`, `drain` event) — in the browser, the Streams API handles more of this automatically and exposes fewer controls.
- Node stream buffers are plain JavaScript arrays/buffers in memory — in the browser, `ReadableByteStream` uses a ring buffer managed by the browser engine; you have less visibility and control.
- Node lets you call `.pause()` and `.resume()` on `Readable` streams — the browser's `ReadableStream` does not have these methods (they deprecated them in favor of automatic backpressure via `pipeTo`).

---

**Confirmation gate:** Any questions on how Node stream backpressure differs from the browser before we move to memory management?

---

#### Item 5: Memory Management & Heap Limits

**Time budget:** 1 hour

**Business use case:** The report generation worker processes 500 supplier polygons, each polygon result stored in memory until the entire batch is complete. At polygon 300, the Node process crashes with no error message. The Kubernetes pod shows status `OOMKilled` in `kubectl get pods`. The heap limit was set to 512MB. What happened — and could it have been caught before the OS killed the process?

**Baseline questions (answer before studying):**

1. In the browser, what is the Chrome V8 heap? Have you ever seen heap size growth over time in the Performance panel and wondered if it was a memory leak?
2. What is the browser's "young generation" (scavenge space) vs. "old generation"? Have you seen these terms in Chrome DevTools' Memory panel?
3. In the browser, if you allocate too much memory — say, a 500MB `ArrayBuffer` — what happens? Does the browser crash, or does it throw a JavaScript error?
4. Have you ever used Chrome DevTools' Memory heap snapshot feature to find detached DOM nodes or retained arrays?
5. Do you know what `--max-old-space-size` is, or have you only encountered it by name in Node.js configuration guides?

**Frontend analogy:** V8 heap management is identical between Chrome and Node — the same V8 engine, the same generations, the same GC algorithms. You've read the Memory panel in Chrome DevTools. You know what a heap snapshot looks like. The main difference is tooling: in the browser you use DevTools; in Node you use `process.memoryUsage()`, `node --inspect`, or `perf_hooks`.

**Key differences from the browser:**
- Browser tabs are killed by the browser when memory runs low — Chrome kills the tab, not the OS process. Node processes can be killed by the OS OOM killer (Linux `oom-killer`) with no graceful degradation.
- Node has no built-in memory growth guard equivalent to what Chrome does internally — once V8 hits its heap limit, it throws a `RangeError`. But the OS can kill the process *before* V8 hits the limit if native memory (outside the V8 heap) is also exhausted.
- Node long-running processes accumulate old-generation heap in ways browser tabs don't — you may never close the process, so GC promotion decisions accumulate over days, not minutes.

---

**Confirmation gate:** Any questions on the V8 heap limit vs. OS OOM distinction before we move to worker threads?

---

#### Item 6: `worker_threads` & Structured Cloning

**Time budget:** 1 hour

**Business use case:** The polygon area calculation runs on a single thread. With 500 polygons, it blocks the event loop for several seconds — the GraphQL endpoint becomes unresponsive. You decide to offload the calculation to a `worker_threads` `Worker`. Data (the GeoJSON polygons) must be passed from the main thread to the worker. What are the constraints on what can be sent — and what happens to a circular reference or a function reference when you send it?

**Baseline questions (answer before studying):**

1. In the browser, have you ever used a `Web Worker`? How did you send data to it — and were there any types of data you couldn't send?
2. What is "structured clone" in the browser Web Workers API? Do you know what types are not cloneable (functions, Symbols, circular references)?
3. In the browser, can two different Web Workers share memory directly, or must they always communicate via message passing?
4. Have you ever used `postMessage()` with an object in the browser and noticed that the receiving end got a copy — not a reference?
5. What does the browser's `Transferable` interface do? Have you used `ArrayBuffer.transfer()` or `MessageChannel` to transfer ownership?

**Frontend analogy:** `worker_threads` in Node is almost identical to Web Workers in the browser. You already know structured cloning, `postMessage`, `MessageChannel`, and `Transferable` from the browser — these concepts transfer directly. The main addition in Node is `SharedArrayBuffer`, which the browser also supports but requires cross-origin isolation (`Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers) to enable safely.

**Key differences from the browser:**
- Node's `worker_threads` gives you access to `workerData` (one-time init data) and `parentPort` (bidirectional channel) — browser Web Workers use `self.postMessage()` and `self.onmessage` which are analogous.
- In Node, `SharedArrayBuffer` works out of the box (no cross-origin restriction) — in the browser it requires `SharedArrayBuffer` to be available AND the page to be served with `COOP`/`COEP` headers.
- Node workers can `import()` dynamically — browser Web Workers have a different module loading mechanism.
- Node does not have an equivalent to the browser's `DedicatedWorkerGlobalScope` vs. `SharedWorkerGlobalScope` distinction — there is no native shared worker in Node.

---

**Confirmation gate:** Any questions on structured cloning constraints or `SharedArrayBuffer` before we move to the awareness items?

---

#### Item 7: Distributed NoSQL Consistency (ScyllaDB/Cassandra) — Awareness

**Time budget:** 30–45 minutes

**Business use case:** The compliance report stores supplier polygons by `supplier_id` as the partition key. A compliance auditor queries all suppliers in a specific region. If the query uses `region` as a filter but `region` is not the partition key, the query fans out across all nodes — this is an expensive query in a multi-tenant SaaS environment with thousands of concurrent requests. What are the implications for latency and cost?

**Baseline questions (answer before studying):**

1. In a relational database (SQL), what is an index? How does it speed up queries — and what is the cost of maintaining one?
2. What does "horizontal scaling" mean for a database? Have you worked with a database that distributed data across multiple machines?
3. In the browser, have you ever heard of the CAP theorem? What does it say about distributed systems?
4. What is the difference between "eventual consistency" and "strong consistency" in a distributed database?
5. Have you encountered the term "partition key" in any database context — NoSQL or otherwise?

**Frontend analogy:** There is no direct browser equivalent to distributed NoSQL, because browser APIs are designed to talk to a single server, not a cluster. But you can think of a partition key like a browser's local storage shard — the same key always routes to the same shard. The CAP theorem is analogous to browser caching consistency: you can serve stale data immediately (eventual) or block until you're sure the data is fresh (linearizable).

**Key differences from the browser:**
- No browser API provides consistency guarantees — the browser simply trusts the server response.
- In a distributed NoSQL cluster, the same query can return different results depending on which node answers — the browser HTTP client never sees this ambiguity; the server does.
- Partition keys in ScyllaDB/Cassandra are analogous to a routing key in a message queue: same key always goes to the same consumer node.

---

**Confirmation gate:** Any questions on partition key design before we move to message queues?

---

#### Item 8: Message Queue Backpressure Patterns — Awareness

**Time budget:** 30 minutes

**Business use case:** The notification dispatch system queues 10,000 emails when a compliance report is published. Each worker can process 100 emails per minute. If you spawn 200 concurrent workers, the email provider's API rate-limits you and starts returning 429 errors. The queue must slow down producers automatically. How does the queue broker signal backpressure — and how does your worker code respond to it?

**Baseline questions (answer before studying):**

1. In the browser, have you ever implemented debouncing or throttling? Can you describe the difference?
2. What happens when you make too many requests to an API in a short period? What does a `429 Too Many Requests` response mean in the browser?
3. In the browser, what is the `navigator.onLine` property? Does it tell you anything about whether your request will succeed?
4. Have you ever used a retry mechanism in frontend code — with exponential backoff? Can you describe the pattern?
5. What is a "dead letter" in the context of a message queue? How does a message end up there?

**Frontend analogy:** Debouncing/throttling maps to consumer-side rate limiting in queues. A 429 response from an API is identical whether you're in the browser or Node — but in Node you handle it in a queue consumer loop, not in a UI event handler. Retry with exponential backoff works the same way in both environments.

**Key differences from the browser:**
- In the browser, backpressure comes from the network layer (TCP congestion, HTTP 429). In a message queue, backpressure is broker-enforced via prefetch limits — the consumer doesn't receive more messages than it can handle.
- Browser retries are implemented in application code. Queue retries are often broker-configurable (e.g., BullMQ's `attempts` and `backoff` settings).
- The browser has no concept of a dead-letter queue (DLQ) — failed requests are lost or re-thrown; in a queue system, failed messages go to the DLQ for later inspection.

---

**Confirmation gate:** Any questions on prefetch vs. consumer rate limiting before we move to profiling?

---

#### Item 9: Event Loop Lag & Profiling — Awareness

**Time budget:** 30 minutes

**Business use case:** A compliance report generation job starts normally, then after 30 seconds the GraphQL query that checks its status starts timing out. The job itself is still running — it's not crashed. The event loop is blocked. You need to prove it with data: show the interviewer the event loop utilization and the function consuming the most CPU time.

**Baseline questions (answer before studying):**

1. In Chrome DevTools, have you ever used the Performance panel to record a slow interaction and found a long task (a "jank" frame)?
2. What does "main thread blocking" mean in the context of browser rendering? What kinds of JavaScript cause it?
3. Have you ever used `console.time()` and `console.timeEnd()` in the browser to measure how long a function takes?
4. In Chrome DevTools, what does a "flamegraph" (in the Performance panel's flame chart view) show you?
5. Do you know what the browser's `PerformanceObserver` API does?

**Frontend analogy:** The Chrome DevTools Performance panel is the browser's profiler. Node's `perf_hooks` and `node --prof` produce flamegraphs that look similar to Chrome's performance traces. The concept of "main thread blocking" maps directly to "event loop lag" — the same phenomenon, measured the same way, just in a different runtime.

**Key differences from the browser:**
- Chrome DevTools has a GUI for profiling. Node profiling uses CLI flags (`node --prof`) and CLI tools (`node --prof-process`) or Chrome DevTools' dedicated Node profiling path.
- Node's `performance.eventLoopUtilization()` API is unique to Node — there is no browser equivalent because the browser doesn't expose event loop timing to JavaScript.
- In the browser, you profile frames per second (fps) to detect jank. In Node, you profile event loop lag (milliseconds between scheduled and executed work) to detect starvation.

---

**Confirmation gate:** Any questions on reading flamegraphs or detecting event loop lag before we move to subscriptions?

---

#### Item 10: GraphQL Subscriptions & WebSocket — Awareness

**Time budget:** 30–45 minutes

**Business use case:** The compliance dashboard needs real-time updates when a supplier submission is processed. The compliance officer should see a progress bar update without refreshing the page. You need to implement a GraphQL subscription on the `Workflow.status` field. The subscription must push updates to all connected dashboard clients within 2 seconds of a status change.

**Baseline questions (answer before studying):**

1. What is WebSocket? Have you ever built a WebSocket connection from scratch — in the browser or in Node?
2. In the browser, what does the WebSocket `close` event tell you? When does the browser automatically reconnect — and when does it not?
3. What is the difference between polling (`setInterval` fetching every N seconds) and a WebSocket push? What are the tradeoffs?
4. In GraphQL, what is the difference between a query and a subscription? Do you know how a subscription is transported over the network?
5. What does "pub/sub" mean in the context of a messaging system? Have you used it in a frontend or backend context?

**Frontend analogy:** You know WebSocket from the browser — the API is `new WebSocket(url)`, `onmessage`, `onclose`, `send()`. The browser GraphQL subscription libraries (`graphql-ws`, `subscriptions-transport-ws`) use WebSocket as the transport. The pub/sub model (single broadcaster → many subscribers) is the same in browser event listeners — you have one `click` event emitter and many `addEventListener('click', handler)` callbacks.

**Key differences from the browser:**
- In the browser, WebSocket is a client API only. In Node, you can be a WebSocket server (`ws` library) or a client — or both.
- Browser WebSocket has automatic ping/pong keepalive. Node WebSocket servers using `ws` library must implement ping/pong manually or configure it.
- The browser closes the WebSocket connection when navigating away — the server sees this as a `close` event. In a subscription model, the server must handle this by unsubscribing the client from pub/sub topics.
- Backpressure in WebSocket: if a client reads slowly, the server's send buffer grows. In the browser you have no control over this. In Node you can detect it via `socket.bufferedAmount`.

---

**Confirmation gate:** Any questions on pub/sub vs. polling tradeoffs before we wrap up?

---

### How to run the sessions

For each topic:

1. **Read the business use case** — put yourself in the scenario
2. **Answer the baseline questions honestly** — this calibrates how much time to spend. Ask one question at a time.
3. **Read the concept introduction** — frontend analogy first, then precision on differences
4. **Ask questions** — if anything is unclear, ask before proceeding
5. **Confirm** — answer "Any questions before we move on?"

Present each section one at a time. Ask me to continue explicitly.

At the end of a session, run create a summary in /study/BACKEND_STUDY_PLAN_SUMMARY_[session number].md.

After all 10 topics, run the **completion check** below.

---

### Completion Check

Answer these before your interview. If you can explain all 10 confidently, you're ready.

1. **Event loop:** Draw the libuv phase order from memory. Explain why `process.nextTick()` runs before `setTimeout` even when both are scheduled at the same time.
2. **V8:** Describe what happens when V8 deoptimizes a function. Name two triggers. Explain why deoptimization causes a latency spike on a live production service.
3. **Error handling:** In a worker pool handler, an async function throws. The error is never caught. Walk through exactly what Node does with it — which handler fires, what the process does, and how to prevent it.
4. **Streams:** You pipe a `Readable` to a `Writable` with a `highWaterMark` of 16KB. The `Writable` is writing to a slow network. Describe the backpressure cycle step by step — from when the buffer fills to when the readable pauses.
5. **Memory:** A Node process in Kubernetes is killed with `OOMKilled`. The heap limit was set to 1GB. The process was using 900MB of V8 heap and 200MB of native memory. Explain what happened — and how to detect it before the OS kills the process.
6. **Worker threads:** You pass a circular object via `workerData` to a `Worker`. What happens? Name two things that structured clone cannot handle.
7. **NoSQL:** You design a table with `supplier_id` as partition key and `region` as a clustering column. A compliance auditor queries by `region` without specifying `supplier_id`. What happens in a ScyllaDB cluster — and why might this be expensive?
8. **Queues:** A worker has a prefetch count of 10. It claims 10 jobs and starts processing them. While processing, the queue broker goes down. What happens to the 10 jobs when the broker comes back?
9. **Profiling:** You suspect event loop lag. Describe exactly how to measure it in Node — which API, which CLI flag, which output format.
10. **Subscriptions:** In GraphQL subscriptions, a subscriber's WebSocket drops mid-stream. Describe what the server must do to clean up correctly — and what can go wrong if it doesn't.

---

*Study session structure designed from "grill-me" interview session.*