import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { v4 as uuid } from 'uuid';
import type { DataSource } from 'typeorm';
import { Workflow, WorkflowStatus } from '../models/Workflow';
import { Task } from '../models/Task';
import { TaskStatus } from '../workers/taskRunner';
import { ApiErrorCode } from '../utils/errorResponse';
import {
    validateWorkflowSteps,
} from './dependencyValidator';

export { WorkflowStatus };

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
     */
    async createWorkflowFromYAML(
        filePath: string,
        clientId: string,
        geoJson: string,
    ): Promise<Workflow> {
        // declare
        const fileContent = fs.readFileSync(filePath, 'utf8');
        let parsed: unknown;
        try {
            parsed = yaml.load(fileContent);
        } catch (error) {
            throw new WorkflowValidationError(
                ApiErrorCode.INVALID_WORKFLOW_FILE,
                `Workflow YAML failed to parse: ${(error as Error).message}`,
            );
        }

        // validate
        const validationError = this.validate(parsed);
        if (validationError) {
            throw new WorkflowValidationError(
                validationError.code,
                validationError.message,
            );
        }

        // perform main logic — at this point validate() has narrowed to steps
        const steps = (parsed as { steps: unknown }).steps;
        const validation = validateWorkflowSteps(steps);
        if (!validation.steps) {
            throw new WorkflowValidationError(
                validation.finding.code,
                validation.finding.message,
            );
        }
        const normalisedSteps = validation.steps;

        const stepNumberToTaskId = new Map<number, string>();
        for (const step of normalisedSteps) {
            stepNumberToTaskId.set(step.stepNumber, uuid());
        }

        const workflowId = uuid();
        const workflow = new Workflow();
        workflow.workflowId = workflowId;
        workflow.clientId = clientId;
        workflow.status = WorkflowStatus.Initial;

        const tasks: Task[] = normalisedSteps.map((step) => {
            const task = new Task();
            const resolvedTaskId = stepNumberToTaskId.get(step.stepNumber);
            if (!resolvedTaskId) {
                throw new Error(
                    `internal: stepNumber ${step.stepNumber} missing from id map`,
                );
            }
            task.taskId = resolvedTaskId;
            task.clientId = clientId;
            task.geoJson = geoJson;
            task.taskType = step.taskType;
            task.stepNumber = step.stepNumber;
            task.dependsOn = step.dependsOn.map((dep) => {
                const resolved = stepNumberToTaskId.get(dep);
                if (!resolved) {
                    throw new Error(
                        `internal: stepNumber ${dep} missing from id map`,
                    );
                }
                return resolved;
            });
            task.status =
                task.dependsOn.length === 0
                    ? TaskStatus.Queued
                    : TaskStatus.Waiting;
            task.workflow = workflow;
            return task;
        });

        // side effects — single atomic transaction (PRD decision 9).
        await this.dataSource.transaction(async (manager) => {
            await manager.getRepository(Workflow).save(workflow);
            await manager.getRepository(Task).save(tasks);
        });

        return workflow;
    }

    /**
     * Pure in-memory validation — no DB. Returns null on success or a
     * `{ code, message }` finding for the first rule violated. Wraps
     * `validateWorkflowSteps` so the public surface stays simple.
     */
    private validate(
        parsed: unknown,
    ): { code: ApiErrorCode; message: string } | null {
        if (
            parsed === null ||
            typeof parsed !== 'object' ||
            !('steps' in parsed)
        ) {
            return {
                code: ApiErrorCode.INVALID_WORKFLOW_FILE,
                message: 'Workflow YAML must define a top-level `steps` array',
            };
        }
        const result = validateWorkflowSteps(parsed.steps);
        return result.finding;
    }
}
