import "reflect-metadata";
import express from "express";
import analysisRoutes from "./routes/analysisRoutes";
import workflowRoutes from "./routes/workflowRoutes";
import defaultRoute from "./routes/defaultRoute";
import {
  startWorkerPool,
  resolveWorkerPoolSize,
  type StopSignal,
} from "./workers/taskWorker";
import { AppDataSource, buildWorkerDataSource } from "./data-source";
import * as logger from "./utils/logger";

const POLL_INTERVAL_MS = 5000;

const app = express();
app.use(express.json());
app.use("/analysis", analysisRoutes);
app.use("/workflow", workflowRoutes);
app.use("/", defaultRoute);

/**
 * Best-effort SIGINT/SIGTERM shutdown (Issue #17 Wave 1). Flips the shared
 * `StopSignal` so worker coroutines exit on their next predicate check,
 * draining any task currently in-flight to its terminal state. The HTTP
 * server keeps serving until the pool drains and Promise.all resolves; only
 * then does the process exit. PRD §General previously documented "no
 * graceful shutdown — process.exit immediately"; this preserves the spirit
 * (no fancy drain timeouts, no signal-aware HTTP keep-alive draining) while
 * making the pool's Promise.all the natural exit barrier.
 */
function registerShutdownHandlers(stopSignal: StopSignal): void {
  const handler = (signal: NodeJS.Signals): void => {
    if (stopSignal.stopped) return;
    logger.info("shutdown signal received — flipping worker pool stop signal", {
      taskType: signal,
    });
    stopSignal.stopped = true;
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

AppDataSource.initialize()
  .then(() => {
    let poolSize: number;
    try {
      poolSize = resolveWorkerPoolSize(process.env.WORKER_POOL_SIZE);
    } catch (error) {
      logger.error("worker pool configuration invalid", { error });
      process.exit(1);
    }
    const stopSignal: StopSignal = { stopped: false };
    registerShutdownHandlers(stopSignal);
    logger.info(`starting worker pool (size=${poolSize})`);
    // Each coroutine builds + initializes its own DataSource against the same
    // file-backed SQLite (Issue #17 Wave 1). WAL is enabled in
    // `buildWorkerDataSource`, so concurrent claims serialise at the SQLite
    // layer instead of corrupting transaction state on a shared connection.
    startWorkerPool({
      size: poolSize,
      dataSourceFactory: buildWorkerDataSource,
      sleepMs: POLL_INTERVAL_MS,
      stopSignal,
    })
      .then(() => {
        logger.info("worker pool drained — exiting");
        process.exit(0);
      })
      .catch((error) => {
        logger.error("worker pool exited with error", { error });
        process.exit(1);
      });

    app.listen(3000, () => {
      logger.info("server listening at http://localhost:3000");
    });
  })
  .catch((error) => logger.error("startup failed", { error }));
