import { ApiErrorCode } from "../utils/errorResponse";

/**
 * Pure in-memory validation for a parsed workflow definition. No DB, no I/O.
 * Returns `null` on success or a structured error object that the caller
 * (`WorkflowFactory`) translates into a thrown `WorkflowValidationError`.
 */

export interface DependencyNode {
  stepNumber: number;
  dependsOn: number[];
}

export interface ValidationFinding {
  code: ApiErrorCode;
  message: string;
}

const KNOWN_TASK_TYPES = new Set(["analysis", "notification", "polygonArea"]);

/**
 * Tarjan-style DFS cycle finder. Returns the closing path
 * (`[start, ..., start]`) for the first cycle hit, or `null` if the graph is
 * a DAG. Self-dependencies are reported as `[n, n]`.
 */
export function detectDependencyCycle(
  nodes: DependencyNode[],
): number[] | null {
  const adjacency = new Map<number, number[]>();
  for (const node of nodes) {
    adjacency.set(node.stepNumber, [...node.dependsOn]);
  }

  const VISITING = 1;
  const VISITED = 2;
  const state = new Map<number, number>();
  const stack: number[] = [];
  let cyclePath: number[] | null = null;

  const visit = (current: number): boolean => {
    if (state.get(current) === VISITED) return false;
    if (state.get(current) === VISITING) {
      const start = stack.indexOf(current);
      cyclePath = [...stack.slice(start), current];
      return true;
    }
    state.set(current, VISITING);
    stack.push(current);
    for (const neighbour of adjacency.get(current) ?? []) {
      if (visit(neighbour)) return true;
    }
    stack.pop();
    state.set(current, VISITED);
    return false;
  };

  for (const node of nodes) {
    if (visit(node.stepNumber)) return cyclePath;
  }
  return null;
}

interface RawStep {
  taskType?: unknown;
  stepNumber?: unknown;
  dependsOn?: unknown;
}

export interface NormalisedStep {
  taskType: string;
  stepNumber: number;
  dependsOn: number[];
}

/**
 * Validates the parsed YAML's `steps` array. On success returns the
 * normalised steps; on failure returns the first finding encountered. Order
 * matches PRD decision 3: shape → duplicates → unknown taskType → missing-ref
 * → cycle.
 */
type ValidationOutcome =
  | { steps: NormalisedStep[]; finding: null }
  | { steps: null; finding: ValidationFinding };

const wrongFile = (message: string): ValidationFinding => ({
  code: ApiErrorCode.INVALID_WORKFLOW_FILE,
  message,
});

function checkStepShape(raw: RawStep): ValidationFinding | null {
  if (typeof raw.stepNumber !== "number" || !Number.isInteger(raw.stepNumber)) {
    return wrongFile(`Step is missing or has non-integer stepNumber: ${JSON.stringify(raw.stepNumber)}`);
  }
  if (typeof raw.taskType !== "string" || raw.taskType.length === 0) {
    return wrongFile(`Step ${raw.stepNumber} is missing taskType`);
  }
  if (!KNOWN_TASK_TYPES.has(raw.taskType)) {
    return wrongFile(`Step ${raw.stepNumber} has unknown taskType '${raw.taskType}'`);
  }
  return null;
}

function normaliseDependsOn(
  raw: RawStep,
  stepNumber: number,
): { dependsOn: number[]; finding: null } | { dependsOn: null; finding: ValidationFinding } {
  if (raw.dependsOn === undefined) return { dependsOn: [], finding: null };
  if (!Array.isArray(raw.dependsOn)) {
    return { dependsOn: null, finding: wrongFile(`Step ${stepNumber} dependsOn must be an array of step numbers`) };
  }
  const dependsOn: number[] = [];
  for (const entry of raw.dependsOn as unknown[]) {
    if (typeof entry !== "number" || !Number.isInteger(entry)) {
      return { dependsOn: null, finding: wrongFile(`Step ${stepNumber} dependsOn must contain only integer step numbers`) };
    }
    dependsOn.push(entry);
  }
  return { dependsOn, finding: null };
}

function normaliseStep(
  raw: RawStep,
  seen: Set<number>,
): { step: NormalisedStep; finding: null } | { step: null; finding: ValidationFinding } {
  const shapeFinding = checkStepShape(raw);
  if (shapeFinding) return { step: null, finding: shapeFinding };
  const stepNumber = raw.stepNumber as number;
  if (seen.has(stepNumber)) {
    return { step: null, finding: wrongFile(`Duplicate stepNumber: ${stepNumber}`) };
  }
  const deps = normaliseDependsOn(raw, stepNumber);
  if (deps.finding) return { step: null, finding: deps.finding };
  return {
    step: { taskType: raw.taskType as string, stepNumber, dependsOn: deps.dependsOn },
    finding: null,
  };
}

function checkReferences(
  normalised: NormalisedStep[],
  seen: Set<number>,
): ValidationFinding | null {
  for (const step of normalised) {
    for (const dep of step.dependsOn) {
      if (!seen.has(dep)) {
        return { code: ApiErrorCode.INVALID_DEPENDENCY, message: `Step ${step.stepNumber} references non-existent step ${dep}` };
      }
    }
  }
  const cycle = detectDependencyCycle(normalised);
  if (cycle) {
    return { code: ApiErrorCode.DEPENDENCY_CYCLE, message: `Cycle detected: ${cycle.join(" → ")}` };
  }
  return null;
}

export function validateWorkflowSteps(steps: unknown): ValidationOutcome {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { steps: null, finding: wrongFile("Workflow has no steps") };
  }
  const normalised: NormalisedStep[] = [];
  const seen = new Set<number>();
  for (const raw of steps as RawStep[]) {
    const outcome = normaliseStep(raw, seen);
    if (outcome.finding) return { steps: null, finding: outcome.finding };
    seen.add(outcome.step.stepNumber);
    normalised.push(outcome.step);
  }
  const refFinding = checkReferences(normalised, seen);
  if (refFinding) return { steps: null, finding: refFinding };
  return { steps: normalised, finding: null };
}
