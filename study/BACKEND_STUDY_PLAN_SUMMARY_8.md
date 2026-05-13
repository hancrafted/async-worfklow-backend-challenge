# Session 8 Summary — Item 8: Message Queue Backpressure Patterns

**Status:** Completed
**Time:** ~30 minutes

---

## Key Learnings

### Prefetch (QoS)
- Controls how many messages a broker sends to a worker before acks
- Low prefetch (1) = slow but fair, memory-safe
- High prefetch = fast throughput but risky if worker crashes mid-batch
- Acts as the broker-layer backpressure signal — prevents worker buffer overflow

### Retry with Exponential Backoff + Jitter
- Pattern: `1s → 2s → 4s → 8s ± jitter`
- Jitter is critical — without it, all workers retry at the same instant (thundering herd)
- BullMQ and similar libraries implement this natively via config (`attempts`, `backoff`)
- After N attempts: message goes to DLQ, not back to the queue

### Dead Letter Queue (DLQ)
- Final resting place for messages that exhaust all retries
- Preserves payload + failure reason for later inspection
- Can be manually replayed after fixing the underlying issue
- Prevents poison messages from looping forever and blocking good messages

### Broker-enforced Backpressure
- **AMQP (RabbitMQ)**: broker sends `channel.flow` frame telling publisher to pause
- **SQS**: queue grows, no explicit pushback — producer observes `ApproximateNumberOfMessages`
- Backpressure signal differs per broker — know your broker's model

### Circuit Breaker
Three-state state machine:
- **Closed** (normal): calls pass through, failures counted
- **Open** (failing fast): calls blocked immediately, no downstream contact
- **Half-Open** (testing): one test call allowed; success → Closed, failure → Open

Key insight: circuit breakers handle **extended outages** where retry-with-backoff would waste enormous resources. They fail fast to keep the system healthy.

---

## Interview Answer Template

> "In a message queue system, backpressure flows both ways. The broker enforces it via prefetch limits — a worker only claims what it can handle. When a downstream API rate-limits us with 429, we retry with exponential backoff and jitter to spread out the herd. Jobs that permanently fail after all retries go to a dead letter queue for later inspection. On top of that, I implement a circuit breaker — three states, closed/open/half-open — so that if an API is down for an extended period, we fail fast instead of wasting resources retrying 24,000 times across 200 workers."

---

## Remaining Awareness Items
- Item 9: Event Loop Lag & Profiling
- Item 10: GraphQL Subscriptions & WebSocket