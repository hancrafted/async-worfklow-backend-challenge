# Backend Study Plan — Item 4: Stream Backpressure in Node

**Status:** ✅ Completed

---

## Session Summary

### What is a Stream

A stream is an object that processes data piece by piece — one chunk at a time — instead of loading the entire dataset into memory first. A "chunk" is a sequence of bytes, not a logical row or array item.

**Readable** — source of data, emits `data` events with chunks.
**Writable** — destination, accepts data via `.write(chunk)`.
**Transform** — sits in the middle, reads from upstream, writes to downstream (e.g. CSV parser, gzip).

### pipe()

`readable.pipe(writable)` connects a Readable to a Writable and automatically handles backpressure. Internally it:
1. Calls `writable.write(chunk)` after each chunk
2. Checks the return value
3. When `false`, calls `readable.pause()`
4. When `drain` fires on the Writable, calls `readable.resume()`

### highWaterMark

A number setting the buffer size limit for a stream (in bytes). When the buffer hits this limit:
- `write()` returns `false` (Writable) — signal to stop writing
- Source stops pushing more data (Readable pauses)

Default: ~16KB (object mode), ~64KB (byte mode).

`highWaterMark` is a flow control signal, not a hard memory cap — the buffer can grow beyond it.

### The Backpressure Cycle

```
ScyllaDB query (Readable)
    ↓ push row
Readable buffer grows
    ↓
pipe() calls writable.write(row)
    ↓
writable.write() returns false (network slow)
    ↓
pipe() calls readable.pause()
    ↓
Network slowly drains, socket buffer empties
    ↓
drain event fires on Writable
    ↓
pipe() calls readable.resume()
    ↓
cycle repeats until all rows sent
```

### Chunk Boundary vs Row Boundary

**Critical:** Streams read bytes, not rows. A chunk can cut through the middle of a CSV row or JSON value. You need a parser (csv-parser, JSONStream, etc.) on top of the raw stream to get complete logical rows.

```
Chunk 1: "id,name,role\nworker1,alice,develop"
Chunk 2: "er\nworker2,bob,devops\n"   ← cuts "developer" in half
```

### When Streaming Does NOT Help

**1. Aggregation requiring all rows:** If you need all 50k rows to compute a result (e.g., percentile), streaming doesn't reduce memory at the aggregation step. Solutions:
- Push the aggregation to the database (`SELECT AVG(...)`)
- Incremental/online algorithms (Welford's for stddev, running totals for SUM/AVG)
- Distributed compute engine for truly complex aggregations

**2. Concurrency vs streaming are different tools:**
- Streaming: don't load everything at once (memory boundedness)
- Concurrency (workers, horizontal scale): complete more work faster
- For 500 x 50MB files: streaming one at a time + worker_threads for parallelism = bounded memory + acceptable throughput

### Streaming and Transactions

Streaming and atomic transactions across all rows are fundamentally in tension. Options:

| Approach | Memory | Atomicity | On Crash |
|---|---|---|---|
| One transaction, all rows | High (defeats streaming) | Full | Full rollback |
| Batch transactions (e.g. 100 rows) | O(batch_size) | Per batch | Last batch lost |
| Auto-committed per row | O(1) | None | Row lost |
| Outbox pattern | O(1) | Per row + outbox | Retried from outbox |

**Design decision:** For compliance data, batch transactions (Option B) most common. Pick batch size that balances throughput against partial failure cost.

### Frontend Use Cases

- File uploads: `fetch(url, { body: fileInput.files[0].stream() })`
- File downloads: `response.body.getReader()` processing chunks without buffering entire file
- Real-time data: Server-Sent Events, WebSocket pushes

### Backend Use Cases

- Serving large files: `createReadStream().pipe(res)` — O(1) memory regardless of file size
- Proxying/gateway: `upstream.body.pipe(res)` — pass bytes through as they arrive
- Processing large DB result sets: `cursor.pipe(csvTransform).pipe(res)`
- Log processing pipelines: chained Transform streams
- Video/audio transcoding: ffmpeg with streams

### Common Mistake: Ignoring Backpressure

```js
// WRONG — ignores write() return value
readable.on('data', (chunk) => {
  writable.write(chunk); // returns false when buffer full, but it's ignored
});
```

This causes unbounded buffer growth → OOM crash. The correct pattern is exactly what `pipe()` does automatically.

---

## Key Terms

- **highWaterMark:** Buffer size limit that triggers backpressure signal
- **Backpressure:** Signal from slow consumer to stop producing more data
- **drain event:** Writable's signal that its buffer has cleared and it's ready for more
- **Transform stream:** A passthrough that can modify data as it flows through
- **Chunk:** A piece of data (bytes) in the stream buffer — NOT a logical row or item

---

## Confirmation Gate

Topics covered: what streams are, pipe() and automatic backpressure, highWaterMark, the backpressure cycle, chunk vs row boundary, when streaming doesn't help (aggregation, concurrency), streaming + transactions tradeoff, frontend and backend use cases.

No questions remaining — ready to proceed to Item 5 (Memory Management & Heap Limits).