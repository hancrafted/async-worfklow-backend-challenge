# Why there is no lease / heartbeat on `in_progress` tasks

The atomic claim in `PRD.md` §10 is just a state transition:

```sql
UPDATE tasks SET status = 'in_progress' WHERE taskId = ? AND status = 'queued'
```

No `claimedAt`, no `leaseExpiresAt`, no heartbeat goroutine, no boot-time recovery sweep. A reviewer with distributed-systems instincts will ask *"where's the lease?"* — most commonly suggesting a **lease-without-heartbeat** model (fixed TTL set at claim time, no refresh). This note is the prepared defense.

## What a lease-without-heartbeat would buy

The model: when a worker claims a task, write `leaseExpiresAt = now + TTL`. If the worker doesn't terminal-transition the row before `leaseExpiresAt`, another worker can re-claim:

```sql
UPDATE tasks
   SET status = 'in_progress', leaseExpiresAt = ?
 WHERE taskId = ?
   AND (status = 'queued'
        OR (status = 'in_progress' AND leaseExpiresAt < ?))
```

It protects against three failure modes:

| Failure mode | Does it apply in this scope? |
|---|---|
| Process crash leaves orphaned `in_progress` rows | **No** — `dropSchema: true` wipes the DB on restart. There is nothing to recover. |
| Worker coroutine throws mid-task | **No** — the per-worker `try/catch` (PRD §11) marks the task `failed`. State is correct without a lease. |
| Worker coroutine **hangs** (unresolved promise / infinite loop) | **Yes**, but a per-job timeout is a more targeted fix (Layer 4). |

So a lease here is solving 1-of-3 cases, and that 1 has a better answer.

## Four-layer defense

### Layer 1 — there is no recovery problem in scope

`dropSchema: true` (`src/data-source.ts`) means every process boot starts on a fresh SQLite file. Orphaned `in_progress` rows from a hard exit cannot survive a restart, so the cross-restart recovery problem a lease typically targets does not exist. The only remaining recovery surface is intra-process; row 2 of the table above shows the worker's exception handler already covers it.

### Layer 2 — lease-without-heartbeat introduces double-execution

Once a TTL exists, a *legitimately long-running* job that exceeds the lease gets re-claimed by another worker while it is still running. That has two consequences neither of which is acceptable for free:

- **Every job must become idempotent** (or carry a "did somebody else terminal-transition this row?" check at completion time). The current jobs have zero idempotency requirements; adding a lease silently introduces that requirement across every job we'll ever write.
- **The TTL value is a guess.** Too low → false re-claims of healthy tasks. Too high → slow recovery from the very case the lease was meant to fix. There is no defensible value without production measurement, which a 5-day challenge cannot produce.

### Layer 3 — the production-grade upgrade path is already documented

`interview/design_decisions.md` General Assumptions already names the production-grade replacement: *"persistent DB + TypeORM migrations + boot-time recovery sweep that resets stale `in_progress` rows older than the worker heartbeat back to `queued`."* That's a heartbeat-lease, gated on dropping `dropSchema: true`. The pragmatic-now / lease-later trade-off is on the page, consistent with the `CLAUDE.md` rubric ("strike a balance between a pragmatic solution scoped to this coding challenge setup and a production grade solution").

### Layer 4 — the right answer to "what about a hung worker?" is a per-job timeout, not a lease

If the interviewer asks *"what if a job hangs forever?"*, the cleanest answer is **not** "we'd add a lease." It is:

> "A `Promise.race(job, rejectAfter(timeoutMs))` per invocation. The race rejects past the timeout, the worker's `try/catch` (PRD §11) catches it as `job_error`, the task transitions to `failed`, and the worker keeps claiming. That handles intra-process hangs precisely, with no double-execution surface, no TTL guesswork, and no idempotency requirement on jobs."

A lease-without-heartbeat is a coarser, more dangerous version of what a per-job timeout already gives you. If the underlying question is *"how do you recover from hangs?"*, the per-job timeout is the right tool; the lease is the wrong tool.

## When I would add a lease

Two narrow conditions, both off the table here:

1. **Persistent DB without `dropSchema`.** Orphaned `in_progress` rows survive reboots; you need a recovery story. The right one is **boot-time sweep + heartbeat-refreshed lease**, not naive TTL-lease — heartbeat refresh is what lets legitimately long jobs not get killed mid-run.
2. **Multi-process / distributed workers.** A coordinator-side claim with a lease becomes meaningful when claims have to survive worker hosts dying. We are explicitly single-process (PRD §10).

Neither condition holds. Add neither.

## Why not "do both" (atomic claim + lease)?

Carrying both produces:

- A new schema column (`leaseExpiresAt`) and lease-aware claim SQL on the hot polling path.
- A new requirement that every job be idempotent — currently not the case.
- A new tunable (TTL) with no measured value to set.
- Zero benefit in this scope, because the cases the lease protects against either don't exist (cross-restart recovery) or have a cleaner alternative (per-job timeout for hangs).

The cost is permanent and code-wide; the benefit is "matching a distributed-systems instinct that doesn't apply to a single-process, ephemeral-DB setup." Net negative.

## Cost of the omission within a single process lifetime

A genuine hang (unresolved promise inside a job) occupies 1 of N worker slots until the process is restarted. With the default `WORKER_POOL_SIZE=3`, that is a 33% capacity loss for as long as the process runs. The mitigation is the per-job timeout in Layer 4, which is the recommended follow-on if the interviewer pushes on hangs. Even without that, the workflow whose task is hung will visibly stall on `/status` — the operator (or reviewer) sees it and restarts.

## Cross-references

- `PRD.md` §10 — the locked atomic-claim decision.
- `PRD.md` §11 — the worker-level `try/catch` that converts job exceptions to `failed` (Layer 1, row 2).
- `PRD.md` "Shutdown semantics — deliberately skipped" — the `dropSchema: true` argument (Layer 1).
- `interview/design_decisions.md` General Assumptions — the production-grade boot-time-sweep alternative (Layer 3).
