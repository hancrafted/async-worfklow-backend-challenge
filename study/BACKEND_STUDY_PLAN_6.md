# Backend Study Plan — Session 6: worker_threads & Structured Cloning

**Date:** 2026-05-12
**Duration:** ~1 hour
**Status:** Completed

---

## Key Learnings

### Structured Clone
- Browser and Node both use structured clone for cross-context data transfer (postMessage, workerData)
- Cannot clone: functions, Symbols, circular references (throws DataCloneError), non-enumerable props, prototype chain
- Structured clone copies data; Transferable transfers ownership (zero-copy, sender loses access)

### Transferables
- `ArrayBuffer`, `MessagePort`, `ImageBitmap`, `OffscreenCanvas` are Transferable
- Transfer = ownership move, not copy. Enables high-throughput data passing without memory duplication
- Node worker_threads supports same transferable mechanism

### worker_threads vs cluster

| | worker_threads | cluster |
|--|--|--|
| Model | Thread (same process) | Process (forked) |
| Memory | V8 heaps isolated, OS memory shared | Each fork has independent OS memory |
| Crash isolation | No — unhandled worker error can crash parent (unless error handler catches it) | Yes — one worker dies, rest survive |
| Communication | Structured clone + SharedArrayBuffer | IPC (serialized pipes) |
| Memory overhead | Low (shared OS memory) | High (full Node instance per worker) |
| Shared memory | Yes (SharedArrayBuffer) | No |

### Key misunderstandings corrected
- V8 isolate = private heap. Worker thread's heap is allocated from process memory but is NOT accessible from parent or other workers. Isolation is at V8 level, not OS level.
- SharedArrayBuffer is allocated outside V8 heap (OS memory), hence accessible from multiple isolates.
- Worker thread crash does NOT automatically kill parent — error must be uncaught. But if parent doesn't handle the error event, the throw in the error handler kills the process.
- Worker threads ARE real OS threads — they can run in parallel on multiple cores (same process, different cores).

### When to use worker_threads over cluster
- CPU-bound offloading with shared memory needs
- Low IPC overhead requirements (frequent data passing)
- Need zero-copy data sharing (SharedArrayBuffer)
- Fault isolation less critical than memory efficiency

### When to prefer cluster
- Fault isolation matters (one worker can leak/crash without affecting others)
- Running many workers (4+ cores) — process isolation aligns with deployment model
- Kubernetes environment — each process is a separate container with resource limits

---

## Baseline Questions Revisited

1. **Web Worker usage** — Used postMessage/onmessage for image rotation. Surface familiarity, not deep mechanics.
2. **Structured clone limits** — Knew about circular refs, guessed JSON.stringify analogy. Learned precise limits.
3. **Memory sharing** — Knew SharedArrayBuffer enables sharing. Learned cross-origin isolation in browser.
4. **postMessage copy behavior** — Knew structured clone means copy. Understood copy-vs-reference.
5. **Transferables** — No prior exposure. Learned ownership transfer concept.

---

## Session Notes

- Process vs thread distinction clarified — OS threads share address space but have private V8 heaps.
- Worker thread OOM can kill entire process (same memory pool). Mitigation: monitor externally, restart workers, consider cluster for stronger isolation.
- Confirmed observation about worker threads being CPU-bound focused — correct but needed nuance: they ARE parallel on multi-core, and only help on single-core when main thread also has work.
- Cluster example provided with respawn logic.
- Final question: why not default to cluster? Answered with fault isolation, memory overhead, IPC speed, shared memory absence trade-offs.