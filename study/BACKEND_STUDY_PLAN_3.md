# Backend Study Plan — Item 3: Async Error Handling & Error Propagation

**Status:** ✅ Completed

---

## Session Summary

### The Three Error Handling Paths (Browser → Node Mapping)

| Browser | Node | What it catches |
|---------|------|-----------------|
| `try/catch` | `try/catch` | Synchronous throws inside async functions |
| `window.onerror` | `process.on('uncaughtException')` | Sync errors at the top level |
| `window.addEventListener('unhandledrejection', ...)` | `process.on('unhandledRejection', ...)` | Promise rejections with no `.catch()` |

### Handled vs. Unhandled Promise Rejections

**Handled:** A `.catch()` or `try/catch` exists somewhere on the Promise chain.

**Unhandled:** The rejection propagates all the way to the top with no handler.

```js
// Unhandled — rejection propagates out of the async function, nobody listening
fetchSupplierData('acme-123');

// Handled — either:
fetchSupplierData('acme-123').catch(err => { ... });
// or
try { await fetchSupplierData('acme-123'); } catch (err) { ... }
```

### Node 15+ Behavior

- **Uncaught sync throw** → `uncaughtException` fires → process crashes
- **Unhandled Promise rejection** → warning fires → process **keeps running** → error is silently swallowed
- This makes Promise rejections more dangerous in production — you don't get a crash signal, just a warning that may go unnoticed

### The Two Worker Pool Failure Modes

1. **Sync error in job handler** → `uncaughtException` → process crashes → K8s restarts → job lost
2. **Rejected Promise (no `.catch()`)** → warning fires → process keeps running → error silently swallowed → job appears succeeded → data inconsistency

The second is worse — silent data corruption is harder to debug than a crash.

### Error Boundary Pattern for Workers

Every async boundary is an error boundary:

```js
async function handleJob(polygon) {
  try {
    await validatePolygon(polygon);
  } catch (err) {
    await markJobFailed(polygon.id, err);  // handle gracefully
    throw err;  // re-throw so pool handler also sees it
  }
}
```

### Worker Thread Errors

Worker errors do NOT propagate via Node's `unhandledRejection` handler — workers have their own V8 context.

- Worker throws sync error → `worker.on('error')` fires on main thread
- Worker has unhandled Promise rejection → lost inside worker, no main-thread handler fires

```js
const worker = new Worker('./worker.js');
worker.on('error', (err) => { ... });  // main thread's error boundary for worker
worker.on('exit', (code) => { ... });   // non-zero code = crashed worker
```

Inside the worker, same error boundary pattern applies:

```js
parentPort.on('message', async ({ polygonId, data }) => {
  try {
    const result = await processPolygon(data);
    parentPort.postMessage({ success: true, result });
  } catch (err) {
    parentPort.postMessage({ success: false, error: err.message });
  }
});
```

### Key Terms

- **Handled rejection:** `.catch()` or `try/catch` exists on the Promise chain
- **Unhandled rejection:** rejection propagates to process level with no handler
- **Error boundary:** `try/catch` around `await` at the job handler level — catches errors before they propagate to the worker/pool level
- **Re-throw after catch:** important so the pool handler's own error handling also fires

---

## Confirmation Gate

Topics covered: browser → Node error handler mapping, handled vs. unhandled Promise rejections, Node 15+ behavior (silent swallow vs. crash), worker pool failure modes (crash vs. silent), error boundary pattern for async workers, worker thread error propagation via `worker.on('error')` instead of `unhandledRejection`.

No questions remaining — ready to proceed to Item 4 (Stream Backpressure).