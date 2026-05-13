# Session 10 Summary — Item 10: GraphQL Subscriptions & WebSocket

**Status:** Completed
**Time:** ~45 minutes

---

## Key Learnings

### WebSocket Lifecycle

- Initiated as HTTP request with `Upgrade: websocket` header
- Server responds with `101 Switching Protocols` — connection upgrades
- After upgrade: bidirectional frames, no HTTP overhead
- Connection closes via `close` frame or error — either side can initiate

**No auto-reconnect** in the native WebSocket API — the browser does not reconnect automatically. You must implement reconnection logic manually (or use a library that does it for you).

### GraphQL Query vs. Subscription

| | Query | Subscription |
|---|---|---|
| Direction | Client → Server (one-shot) | Client ↔ Server (persistent) |
| Transport | HTTP/JSON | WebSocket |
| Use case | Fetch data once | Receive continuous updates |

Query = request-response, done. Subscription = client subscribes, server pushes whenever data changes.

### graphql-ws Protocol (the subscription transport)

Messages over WebSocket:
```js
// Client → Server: subscribe
{ "type": "subscribe", "id": "1", "payload": { "query": "subscription OnWorkflowStatus { workflowUpdated { id status } }" } }

// Server → Client: push next result
{ "type": "next", "id": "1", "payload": { "data": { "workflowUpdated": { "id": "123", "status": "COMPLETED" } } } }

// Server → Client: complete (subscription done)
{ "type": "complete", "id": "1" }
```

Connection lifecycle: `connection_init` → `subscribe` → `next` (pushed) → `complete`.

### Pub/Sub Pattern (browser analogy: RxJS Subject)

Pub/sub decouples publishers from subscribers. Events go to a central broker; subscribers receive notifications without the publisher knowing who they are.

**Browser analogy:** RxJS `Subject` — you call `.next(value)` and all subscribers receive it. No subscriber? Event drops on the floor.

**GraphQL subscription flow:**
```
Workflow Service (publisher) → PubSub broker → Subscription Resolver (subscriber) → WebSocket → Dashboard Client
```

Single-instance: in-memory pub/sub (`EventEmitter` or `AsyncEmitter`).
Multi-instance (multiple pods): Redis pub/sub — one instance publishes, Redis broadcasts to all instances.

### Server Cleanup on Client Disconnect — Critical

When a client disconnects:
1. WebSocket `onclose` fires
2. Server must unsubscribe from pub/sub topic
3. Otherwise: zombie subscription — server keeps processing events and trying to send to a dead client

Failure modes:
- Memory leak: event keep being published to a dead connection
- Wasted CPU: resolver keeps firing for no listener
- `socket.bufferedAmount` grows: server send buffer fills up because no one is reading

### Backpressure in WebSocket (Node only, not browser)

- `socket.bufferedAmount` in Node = number of bytes queued in send buffer
- If client reads slowly or is disconnected, bufferedAmount grows
- You can detect this and pause publishing when buffer is too high
- The browser's WebSocket API has no equivalent — you have no visibility into send buffer

### Ping/Pong Keepalive

- TCP connections can go silent and proxies/routers can drop idle connections
- WebSocket implementations send ping/pong frames to keep connection alive
- Node's `ws` library: configure `clientTracking` and `pingInterval`; without this, long-lived connections can die silently

---

## Interview Answer Template

> "For real-time compliance status updates, I use GraphQL subscriptions over WebSocket. The client connects via the graphql-ws protocol, subscribes to workflow status changes, and the server pushes updates whenever the status changes. Under the hood, the workflow service publishes events to a pub/sub broker, the subscription resolver subscribes to that topic, and pushes flow over the WebSocket to the dashboard. On disconnect, the server must unsubscribe from the pub/sub topic — otherwise zombie subscriptions cause memory leaks and wasted CPU. For multi-instance deployments, Redis backs the pub/sub so events propagate across all pods. If a client reads slowly, I detect backpressure via `socket.bufferedAmount` and pause publishing until the buffer drains."

---

## All 10 Items Complete ✅

All awareness and core items are now complete. Proceed to the Completion Check in BACKEND_STUDY_PLAN.md to verify readiness for the interview.