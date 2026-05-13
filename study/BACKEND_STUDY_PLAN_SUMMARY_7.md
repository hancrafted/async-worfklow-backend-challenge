# Session 7 Summary — Item 7: Distributed NoSQL Consistency (ScyllaDB/Cassandra)

**Status:** Completed
**Time:** ~45 minutes

---

## Key Learnings

### CAP Theorem — CP vs AP
- Partition tolerance is mandatory (cannot opt out)
- CP prioritizes consistency → system unavailable during partition
- AP prioritizes availability → system stays up with stale data (eventual consistency)
- CAP "consistency" = linearizability (reads appear atomic), not SQL ACID consistency

### ScyllaDB/Cassandra as AP System
- Default: eventual consistency, tunable per-query via consistency level
- Data replicated across N nodes (rf=3 standard)
- Node failure → read repair / hinted handoff / anti-entropy heal automatically
- Data is NOT lost when a node goes down — replicas survive

### Consistency Levels (replication factor = 3)
| Level | Replicas required | Latency | Staleness |
|-------|-------------------|---------|-----------|
| ONE | 1 (local node) | Fastest | Most eventual |
| LOCAL_QUORUM | 2 (local DC) | Medium | Strong within DC |
| QUORUM | 2 (all DCs) | Higher | Strong cross-DC |
| ALL | 3 (all replicas) | Slowest | Always consistent |

- `LOCAL_QUORUM` is the practical default for single-DC deployments

### Partition Key — Most Critical Design Decision
- Partition key hashes to a token → determines which node holds the data
- All data with same partition key lives on same node + replicas
- Queries WITHOUT the partition key fan out to ALL nodes (expensive)
- Hot partitions = irreversible bottleneck problem
- Clustering key = sort order within a partition (enables range queries)

### Working with Eventual Consistency (Practical Rules)
1. **Read-your-own-writes not guaranteed** — use `LOCAL_QUORUM` for writes + reads after a write
2. **Model tables around query patterns** — not entities; each access pattern needs its own table
3. **Writes must be idempotent** — retries must not corrupt data (use upserts, IF conditions)
4. **No cross-partition transactions** — co-locate related data in same partition or handle inconsistency explicitly
5. **Tombstones are operational pain** — don't delete frequently; use partition drops instead

---

## Interview Answer Template

> "When working on top of an eventually consistent AP database like ScyllaDB, I design around four constraints: (1) I don't assume read-your-own-writes without LOCAL_QUORUM; (2) I model tables around query patterns, not entities; (3) I make writes idempotent so retries don't corrupt data; (4) I avoid cross-partition operations by co-locating related data in the same partition — and when that's not possible, I handle the inconsistency explicitly."

---

## Remaining Awareness Items
- Item 8: Message Queue Backpressure Patterns
- Item 9: Event Loop Lag & Profiling
- Item 10: GraphQL Subscriptions & WebSocket