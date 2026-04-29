import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { v4 as uuid } from 'uuid';
import type { DataSource } from 'typeorm';
import { Workflow, WorkflowStatus } from '../models/Workflow';
import { Task, TaskStatus } from '../models/Task';
import { ApiErrorCode } from '../utils/errorResponse';
import {
    validateWorkflowSteps,
    type NormalisedStep,
    type ValidationFinding,
} from './dependencyValidator';

type ParseOutcome =
    | { parsed: unknown; finding: null }
    | { parsed: null; finding: ValidationFinding };

type NormalisedOutcome =
    | { steps: NormalisedStep[]; finding: null }
    | { steps: null; finding: ValidationFinding };

/**
 * Thrown by `WorkflowFactory.createWorkflowFromYAML` when the YAML payload
 * cannot be persisted because of a validation rule from PRD decision 3. The
 * `code` field maps 1:1 onto the `ApiErrorCode` enum so route handlers can
 * forward it via `errorResponse(...)` without remapping.
 */
export class WorkflowValidationError extends Error {
    public readonly code: ApiErrorCode;

    constructor(code: ApiErrorCode, message: string) {
        super(message);
        this.name = 'WorkflowValidationError';
        this.code = code;
    }
}

export class WorkflowFactory {
    constructor(private dataSource: DataSource) {}

    /**
     * Parses the YAML, validates fully in memory, mints UUIDs app-side, and
     * persists the workflow + all tasks atomically inside a single
     * `dataSource.transaction(...)`. Either the caller gets a fully-formed
     * workflow back (success) or a `WorkflowValidationError` (no DB writes).
     *
     * Body is intentionally an orchestrator: each phase is a named helper so
     * the sequence (parse → validate → mint ids → build entities → persist)
     * reads top-to-bottom.
     */
    async createWorkflowFromYAML(
        filePath: string,
        clientId: string,
        geoJson: string,
    ): Promise<Workflow> {
        const parsing = this.parseYamlFile(filePath);
        if (parsing.finding) throw new WorkflowValidationError(parsing.finding.code, parsing.finding.message);
        const validation = this.validateAndNormalize(parsing.parsed);
        if (validation.finding) throw new WorkflowValidationError(validation.finding.code, validation.finding.message);
        const stepIdByNumber = this.mintTaskIds(validation.steps);
        const workflow = this.buildWorkflow(clientId);
        const tasks = this.buildTasks(validation.steps, stepIdByNumber, workflow, { clientId, geoJson });
        await this.persistAtomically(workflow, tasks);
        return workflow;
    }

    /**
     * Reads the YAML file from disk and parses it. Returns `{ parsed }` on
     * success or `{ finding }` on parse failure — never throws (the
     * orchestrator is the only thrower per CLAUDE.md §Functions).
     */
    private parseYamlFile(filePath: string): ParseOutcome {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        try {
            return { parsed: yaml.load(fileContent), finding: null };
        } catch (error) {
            return {
                parsed: null,
                finding: {
                    code: ApiErrorCode.INVALID_WORKFLOW_FILE,
                    message: `Workflow YAML failed to parse: ${(error as Error).message}`,
                },
            };
        }
    }

    /**
     * Pure in-memory validation — no DB. Checks the top-level shape, then
     * delegates the per-step rules to `validateWorkflowSteps`. Returns the
     * normalised steps on success or the first finding encountered.
     */
    private validateAndNormalize(parsed: unknown): NormalisedOutcome {
        if (parsed === null || typeof parsed !== 'object' || !('steps' in parsed)) {
            return {
                steps: null,
                finding: {
                    code: ApiErrorCode.INVALID_WORKFLOW_FILE,
                    message: 'Workflow YAML must define a top-level `steps` array',
                },
            };
        }
        return validateWorkflowSteps(parsed.steps);
    }

    /** Mints a fresh task UUID for every step, keyed by `stepNumber`. */
    private mintTaskIds(steps: NormalisedStep[]): Map<number, string> {
        const stepIdByNumber = new Map<number, string>();
        for (const step of steps) {
            stepIdByNumber.set(step.stepNumber, uuid());
        }
        return stepIdByNumber;
    }

    /** Builds the unsaved `Workflow` aggregate root in the `Initial` state. */
    private buildWorkflow(clientId: string): Workflow {
        const workflow = new Workflow();
        workflow.workflowId = uuid();
        workflow.clientId = clientId;
        workflow.status = WorkflowStatus.Initial;
        return workflow;
    }

    /**
     * Builds the unsaved `Task` entities, resolving `dependsOn` step numbers
     * to the freshly-minted task IDs. A task with no dependencies starts
     * `Queued`; otherwise it starts `Waiting` and the worker promotes it.
     */
    private buildTasks(
        steps: NormalisedStep[],
        stepIdByNumber: Map<number, string>,
        workflow: Workflow,
        context: { clientId: string; geoJson: string },
    ): Task[] {
        return steps.map((step) => {
            const task = new Task();
            task.taskId = this.requireTaskId(stepIdByNumber, step.stepNumber);
            task.clientId = context.clientId;
            task.geoJson = context.geoJson;
            task.taskType = step.taskType;
            task.stepNumber = step.stepNumber;
            task.dependsOn = step.dependsOn.map((dep) =>
                this.requireTaskId(stepIdByNumber, dep),
            );
            task.status =
                task.dependsOn.length === 0
                    ? TaskStatus.Queued
                    : TaskStatus.Waiting;
            task.workflow = workflow;
            return task;
        });
    }

    /**
     * Defensive lookup — `validateWorkflowSteps` already guarantees every
     * `dependsOn` reference resolves, so a miss here is an invariant
     * violation, not a user-facing validation error.
     */
    private requireTaskId(
        stepIdByNumber: Map<number, string>,
        stepNumber: number,
    ): string {
        const taskId = stepIdByNumber.get(stepNumber);
        if (!taskId) {
            throw new Error(
                `internal: stepNumber ${stepNumber} missing from id map`,
            );
        }
        return taskId;
    }

    /** Single atomic transaction (PRD decision 9): all-or-nothing persist. */
    private async persistAtomically(
        workflow: Workflow,
        tasks: Task[],
    ): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            await manager.getRepository(Workflow).save(workflow);
            await manager.getRepository(Task).save(tasks);
        });
    }
}
