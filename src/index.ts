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
import { Task } from "./models/Task";
import { AppDataSource } from "./data-source";
import * as logger from "./utils/logger";

const POLL_INTERVAL_MS = 5000;

const app = express();
app.use(express.json());
app.use("/analysis", analysisRoutes);
app.use("/workflow", workflowRoutes);
app.use("/", defaultRoute);

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
    logger.info(`starting worker pool (size=${poolSize})`);
    void startWorkerPool({
      size: poolSize,
      repository: AppDataSource.getRepository(Task),
      sleepMs: POLL_INTERVAL_MS,
      stopSignal,
    });

    app.listen(3000, () => {
      logger.info("server listening at http://localhost:3000");
    });
  })
  .catch((error) => logger.error("startup failed", { error }));
