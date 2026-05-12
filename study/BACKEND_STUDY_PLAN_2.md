# Backend Study Plan — Item 2: V8 Internals, JIT, Deoptimization & GC Pressure

**Status:** ✅ Completed

---

## Session Summary

### Hidden Classes & Inline Caching

- **Hidden classes (maps):** Shared across all objects with identical shape and property order throughout the entire process. Not function-specific — any object can share a hidden class with any other object of the same shape.
- **Property order matters:** `{x, y}` and `{y, x}` have different hidden classes.
- **Inline caching:** V8 attaches caches to call sites (not functions). On first call, V8 learns the shape and caches the property memory offset. On subsequent calls with the same shape → direct memory read (fast). With different shapes → cache miss → dictionary lookup (slower).
- **Monamorphic → Polymorphic → Megamorphic:** Call sites that see 1 shape are fastest. 2-3 shapes = polymorphic. 4+ shapes = megamorphic, V8 abandons caching and falls back to dictionary lookup on every call.
- **TypeScript note:** TypeScript enforces shapes at compile time but does not emit shape metadata to V8. V8 sees plain objects at runtime. TypeScript helps developers maintain consistent shapes but doesn't directly affect V8 optimization.

### Deoptimization Triggers

1. **Megamorphic call sites** — too many different shapes flow through the same call site. In the polygon batch scenario: if polygon objects have structural variations, after ~4 unique shapes the call site becomes megamorphic and V8 falls back to dictionary lookup.
2. **Shape mutation** — adding or deleting properties on an object changes its hidden class at runtime.
3. **Try/catch in the call chain** — TurboFan refuses to inline through functions containing try/catch (or that call such functions), because try blocks make control flow unpredictable.
4. **Type changes** — V8 assumes a variable is integer but it later becomes a float/object.

Deoptimization is **not permanent** — V8 can re-optimize if shapes stabilize again. The feedback vector updates continuously.

### JIT Pipeline

1. **Ignition (interpreter):** Executes bytecode, records type feedback (what shapes flow through which call sites, function call counts, slot types). Lives in feedback vectors in the V8 heap.
2. **Sparkplug (baseline compiler):** Fast compilation, no optimization, kicks in after ~3-4 invocations. ~2-5x faster than interpreted.
3. **TurboFan (optimizing compiler):** Uses type feedback to compile highly optimized machine code. Applies loop invariant code motion, constant folding, dead code elimination, function inlining, escape analysis, bounds check elimination. Requires consistent type feedback to apply optimizations.

**Heating up:** V8 increments counters on each function call and loop back-edge. When a threshold is crossed, the function is queued for compilation. Workers start cold and have their own independent feedback vectors.

### GC in Node

- **Scavenge (young generation):** Fast, copies short-lived objects. Sub-millisecond pauses.
- **Mark-sweep (old generation):** Marks reachable objects, sweeps unreachable. Longer pause.
- **Mark-compact:** Compacts memory after sweep, reduces fragmentation. Can be 100ms+ on large heaps.
- GC is triggered when allocation budget is exhausted — V8 stops the main thread and reclaims memory.
- Long-running processes accumulate old-generation heap in ways browser tabs never reach.

### Node vs Browser Differences

- Browser tabs are killed by the browser when memory runs low (Chrome kills the tab, not the OS process).
- Node has no built-in memory growth guard — V8 throws `RangeError` at heap limit, but OS OOM killer can fire first if native memory is also exhausted.
- `--max-old-space-size` caps the old generation. Scavenges become more frequent as you approach the limit.
- Production Node apps often run multiple V8 isolates (via `cluster` module). Each isolate has its own heap.
- Workers are isolated V8 contexts — they do NOT share hidden classes with the main thread. Each Worker has its own JIT pipeline and must warm up independently.

### Performance Gains

- Pure computation with consistent shapes: **10-100x faster** than interpreted bytecode (TurboFan).
- Geometric calculations like polygon area with predictable types: high end of range (50-100x).
- With shape variations / megamorphic call sites: 2-5x range.
- Per-property lookup difference: ~3-5 CPU cycles (dictionary) vs ~1 CPU cycle (inline cache hit). Measurable at millions of iterations, not at typical request handler scale.
- **Key benefit:** sustained throughput over time in long-running servers handling many requests, not single-request improvement.

### Worker Threads & Optimization

- New Worker per task: pays warmup cost every time, never reaches full optimization.
- Persistent worker: warmup once, retains optimization across tasks.
- Architectural implication: reuse workers across tasks in a worker pool to benefit from accumulated optimization.

### Daily Restart Rationale (K8s)

Long-running processes accumulate: memory leaks, V8 optimization decay (accumulated deoptimizations), heap fragmentation. Daily restarts reset V8 heap to young generation only and restore fresh optimization state. Valid operational safeguard for well-tested batch workers.

---

## Key Terms

- **Hidden class (map):** V8's internal representation of an object's shape.
- **Inline caching:** V8 caches the memory offset of a property at a call site for fast access.
- **Megamorphic:** Call site that has seen too many shapes (>3-4) for V8 to cache.
- **Deoptimization:** V8 abandoning optimized code and falling back to slower tiers.
- **Feedback vector:** Per-function data structure storing type observations used by TurboFan.
- **Sparkplug:** V8's baseline JIT compiler, fast but unoptimized.
- **TurboFan:** V8's optimizing JIT compiler, uses type feedback to produce fast machine code.
- **Scavenge:** Young generation GC, fast, copies objects.
- **Mark-sweep / Mark-compact:** Old generation GC algorithms, longer pauses.

---

## Confirmation Gate

Topics covered: hidden classes, inline caching, megamorphic call sites, deoptimization triggers (shape mutation, try/catch, type changes), JIT pipeline (Ignition → Sparkplug → TurboFan), GC pauses and generations, Node vs browser heap differences, worker thread isolation, daily restart rationale.

No questions remaining — ready to proceed to Item 3 (Async Error Handling).