import { describe, it, expect, vi, afterEach } from "vitest";
import { LogLevel, error as logError, info, warn } from "./logger";

// Co-located unit tests for the JSON-line logger wrapper (PRD §11 / US22).
// Asserts the emitted line shape and the ≤10-line stack truncation. Captures
// stdout/stderr writes via console.log/console.error spies so the test runner
// is not polluted with logger output.

interface LogLine {
  level: LogLevel;
  ts: string;
  msg: string;
  workflowId?: string;
  taskId?: string;
  stepNumber?: number;
  taskType?: string;
  error?: { message: string; stack?: string };
}

const captureLog = (
  channel: "log" | "error",
  emit: () => void,
): LogLine => {
  const spy = vi.spyOn(console, channel).mockImplementation(() => {});
  emit();
  expect(spy).toHaveBeenCalledTimes(1);
  const arg = spy.mock.calls[0][0] as string;
  return JSON.parse(arg) as LogLine;
};

afterEach(() => vi.restoreAllMocks());

describe("logger — JSON-line wrapper (PRD §11 / US22)", () => {
  describe("happy path: emits one JSON line per call with the documented shape", () => {
    it("info(msg, ctx) emits {level,ts,msg,...ctx} to console.log as a single JSON line", () => {
      // Single info call with the full PRD §11 context surface; asserts the
      // emitted shape and that ts is an ISO-8601 string.
      const line = captureLog("log", () =>
        info("starting job", {
          workflowId: "wf-1",
          taskId: "t-1",
          stepNumber: 2,
          taskType: "polygonArea",
        }),
      );
      expect(line.level).toBe(LogLevel.Info);
      expect(line.msg).toBe("starting job");
      expect(line.workflowId).toBe("wf-1");
      expect(line.taskId).toBe("t-1");
      expect(line.stepNumber).toBe(2);
      expect(line.taskType).toBe("polygonArea");
      expect(new Date(line.ts).toISOString()).toBe(line.ts);
    });

    it("warn(msg) emits to console.log; error(msg) emits to console.error", () => {
      const warnLine = captureLog("log", () => warn("queue empty"));
      expect(warnLine.level).toBe(LogLevel.Warn);
      expect(warnLine.msg).toBe("queue empty");

      const errorLine = captureLog("error", () => logError("boom"));
      expect(errorLine.level).toBe(LogLevel.Error);
      expect(errorLine.msg).toBe("boom");
    });

    it("omits absent context keys entirely (no `undefined` properties in the JSON)", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      info("bare");
      const raw = spy.mock.calls[0][0] as string;
      expect(raw).not.toMatch(/undefined/);
      const line = JSON.parse(raw) as LogLine;
      expect(Object.prototype.hasOwnProperty.call(line, "workflowId")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(line, "taskId")).toBe(false);
    });
  });

  describe("error path: serializes Error and truncates stack to ≤10 lines", () => {
    it("error(msg, { error }) attaches { message, stack } with stack truncated to 10 lines", () => {
      // Build an Error with a 30-line stack; the emitted error.stack must be
      // exactly the first 10 lines, joined by \n.
      const err = new Error("kaboom");
      err.stack = Array.from({ length: 30 }, (_, i) => `frame ${i}`).join("\n");
      const line = captureLog("error", () => logError("job failed", { error: err }));
      expect(line.error?.message).toBe("kaboom");
      const stackLines = line.error?.stack?.split("\n") ?? [];
      expect(stackLines).toHaveLength(10);
      expect(stackLines[0]).toBe("frame 0");
      expect(stackLines[9]).toBe("frame 9");
    });

    it("non-Error thrown values are coerced to a string message with no stack", () => {
      const line = captureLog("error", () => logError("weird", { error: "oops" }));
      expect(line.error?.message).toBe("oops");
      expect(line.error?.stack).toBeUndefined();
    });
  });
});
