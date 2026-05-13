# Session 9 Summary — Item 9: Event Loop Lag & Profiling

**Status:** Completed
**Time:** ~30 minutes

---

## Key Learnings

### Event Loop Lag — The Core Metric

- Event loop lag = time between when work is **scheduled** and when it **executes**
- Normal lag: ~0ms (work runs immediately after current task)
- Blocked lag: 3000ms+ (long sync task blocks everything behind it)
- **Starved**: event loop has nothing to do, sits idle
- **Saturated**: event loop is fully occupied, new work backs up

The compliance report scenario (job starts normal → GraphQL status timeouts after 30s) is saturation — the event loop is fully consumed by the CPU-bound polygon calculation, blocking new work.

### perf_hooks — Node's Performance API

```js
import { performance } from 'perf_hooks';

// Event loop utilization — how busy is the loop?
const { idle, active, utilization } = performance.eventLoopUtilization();
// utilization: 0 = idle, 1 = fully saturated
```

Node-specific API with no browser equivalent — the browser doesn't expose event loop timing to JavaScript.

### Profiling Tools

| Tool | What it does |
|------|--------------|
| `node --inspect` | Full Chrome DevTools debugger for Node; set breakpoints, step in/out, inspect variables, see call stack |
| `node --inspect-brk` | Same as `--inspect` but breaks immediately on start (before any code runs) |
| `node --prof` | Built-in CPU profiler; produces tick log |
| `node --prof-process` | Converts tick log to readable report (flamegraph-style) |
| VS Code debugger | Same experience as browser DevTools — click gutter to set breakpoints, F5 to run with debug |

### Flamegraph — Reading It

A flamegraph shows call stacks over time:
- Horizontal bars = functions running at a moment
- Width of bar = how long the function ran (wide = CPU intensive)
- Depth = call stack (topmost = currently running, bar below = caller)
- Indentation in text output shows call hierarchy

Example output from `node --prof-process`:
```
3556   Something.Close:
2890     Something.ProcessBatch:
1203       Something.Calculate:
 498         Something.ParsePolygon:
  87           Buffer.from
```

The widest bar at the top is your biggest CPU consumer — drill down by following the indentation.

### Long Task Analogy

Browser jank (dropped frames) = same phenomenon as Node event loop saturation. In both cases:
- A long synchronous task blocks all other work
- Measurement: frames per second (browser) vs. event loop lag (Node)
- Fix: break up long tasks, offload to workers, yield periodically

### Debugging Node Like Browser DevTools

- Start with `node --inspect` → open `chrome://inspect` → Remote Target → inspect
- VS Code: click gutter to set breakpoints, F5 to run with debug
- Breakpoints, step in/out, call stack, variable inspection — identical to browser

---

## Interview Answer Template

> "When a worker appears to hang, I measure event loop lag using `perf_hooks.performance.eventLoopUtilization()` — it tells me how saturated the loop is. If utilization is 0.99 while throughput drops, the loop is saturated, not starved. To find the cause, I use `node --inspect` with Chrome DevTools to step through the running code — same breakpoints, same call stack view, just targeting a Node process instead of a browser. For production profiling without blocking, I run `node --prof` to get a tick log, then `node --prof-process` to convert it into a flamegraph that shows which function is consuming the most CPU time."

---

## Remaining Awareness Item
- Item 10: GraphQL Subscriptions & WebSocket