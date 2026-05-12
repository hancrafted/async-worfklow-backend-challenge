# Backend Study Plan — Item 5: Memory Management & Heap Limits

**Status:** ✅ Completed

---

## Session Summary

### V8 Heap Generations

V8 splits its heap into three spaces:

**Young generation (Scavenge Space)** — 1–8 MB. Short-lived objects: function locals, temporary arrays. Allocation is O(1) via pointer bump. When full, V8 runs a **scavenge** — copies live objects to the other half, discards dead ones. Fast, stop-the-world, sub-millisecond for small heaps.

**Old generation (Mark-Sweep/Compact Space)** — objects that survived 2+ scavenges. Compliance report data, cached supplier records, workflow state. Grows to `--max-old-space-size` (default 512MB on 64-bit). GC here is mark-sweep + mark-compact — stop-the-world pauses that can reach 100ms+ on large heaps.

**Large object space** — objects larger than ~1MB. Bypasses normal heap fragmentation.

### `--max-old-space-size`

```
node --max-old-space-size=1024 worker.js  # 1GB cap on old generation
```

A **cap** on V8's old generation heap, not a protective guard. When the old generation hits this limit:
1. V8 triggers emergency GC
2. If GC cannot free enough memory → `RangeError: Invalid array length`
3. Process enters an unrecoverable state

Critical: if native memory outside V8's heap also grows (addons, SharedArrayBuffer), the OS OOM killer fires before V8 ever hits the limit. V8 cannot protect you from OS-level memory pressure.

### `process.memoryUsage()`

```js
const mem = process.memoryUsage();
// { rss: 50331648, heapTotal: 16318464, heapUsed: 9752, external: 79587, arrayBuffers: 0 }
```

- `heapTotal` — total size of V8's heap (all spaces)
- `heapUsed` — live data in the heap
- `external` — memory managed by V8 but outside JS heap (e.g. ArrayBuffer/Buffer data)
- `rss` (Resident Set Size) — total process memory, including OS-level allocations, native memory, code, stack

A 10MB `Buffer` shows as `external` in `heapUsed` but larger in `rss`. In the Acme Wheels scenario: 900MB `heapUsed` + 200MB native + runtime overhead = pod hitting its 1GB Kubernetes memory limit.

### What happens at the heap limit

```
Polygon 298 → all results stored in array
Polygon 299 → V8 tries to allocate, old gen at limit
Polygon 300 → V8 triggers emergency GC
             GC cannot free enough
             V8 throws RangeError
             Process enters unrecoverable state
             JavaScript cannot catch this error reliably
             (OOM happens at C++ level before the error propagates)
```

### Common memory leak patterns in Node

1. **Global caches** — `Map`/`Set` growing indefinitely without eviction
2. **Event listener buildup** — `emitter.on()` without `emitter.off()`
3. **Closure captures** — callback holding a reference to a large object graph
4. **Accidental global variables** — assigning to `global.pendingResults = []` instead of `const`

### Detection tooling

- `process.memoryUsage()` — poll in a loop, track `heapUsed` over time
- `node --inspect` — attach Chrome DevTools, Memory tab, heap snapshots
- `node --expose-gc` + `global.gc()` — manually trigger GC to isolate leak from normal growth
- Linux: `dmesg | grep -i oom` — shows OS OOM killer events after the fact

---

## Key Terms

- **Young generation (scavenge space):** 1–8 MB, fast O(1) allocation, frequent quick GC
- **Old generation:** where survivors go, subject to mark-sweep/compact, pauses can be 100ms+
- **Large object space:** objects >~1MB bypass normal heap fragmentation
- **`--max-old-space-size`:** cap on old generation heap — not a guard against OS OOM
- **`process.memoryUsage()`:** `heapUsed` vs `heapTotal` vs `external` vs `rss`
- **V8 RangeError at heap limit:** unrecoverable — thrown at C++ level, may not be catchable in JS
- **OS OOM killer:** fires when system memory is exhausted — V8 cannot intercept it

---

## Confirmation Gate

Topics covered: V8 heap generations (young/old/large-object), `--max-old-space-size` as a cap not a guard, `process.memoryUsage()` fields and what they measure, what happens when V8 hits the limit vs. when the OS kills the process, common leak patterns, detection tooling.

No questions remaining — ready to proceed to Item 6 (`worker_threads`).
