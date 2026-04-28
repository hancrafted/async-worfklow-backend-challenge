import { Repository } from 'typeorm';
import { Task } from '../models/Task';
import { getJobForTaskType } from '../jobs/JobFactory';
import {WorkflowStatus} from "../workflows/WorkflowFactory";
import {Workflow} from "../models/Workflow";
import {Result} from "../models/Result";
import { serializeJobError } from '../utils/serializeJobError';

export enum TaskStatus {
    Queued = 'queued',
    Waiting = 'waiting',
    InProgress = 'in_progress',
    Completed = 'completed',
    Failed = 'failed',
    Skipped = 'skipped'
}

export class TaskRunner {
    constructor(
        private taskRepository: Repository<Task>,
    ) {}

    /**
     * Runs the appropriate job based on the task's type, managing the task's status.
     * @param task - The task entity that determines which job to run.
     * @throws If the job fails, it rethrows the error.
     */
    async run(task: Task): Promise<void> {
        task.progress = 'starting job...';
        await this.taskRepository.save(task);
        const job = getJobForTaskType(task.taskType);

        try {
            console.log(`Starting job ${task.taskType} for task ${task.taskId}...`);
            const taskResult = await job.run({ task, dependencies: [] });
            console.log(`Job ${task.taskType} for task ${task.taskId} completed successfully.`);

            await this.taskRepository.manager.transaction(async (entityManager) => {
                const resultRepository = entityManager.getRepository(Result);
                const result = new Result();
                result.taskId = task.taskId!;
                result.data = JSON.stringify(taskResult || {});
                await resultRepository.save(result);
                task.resultId = result.resultId!;
                task.status = TaskStatus.Completed;
                task.progress = null;
                await entityManager.getRepository(Task).save(task);
            });

        } catch (error: any) {
            console.error(`Error running job ${task.taskType} for task ${task.taskId}:`, error);

            const errorRecord = serializeJobError(error);
            await this.taskRepository.manager.transaction(async (entityManager) => {
                const resultRepository = entityManager.getRepository(Result);
                const failureResult = new Result();
                failureResult.taskId = task.taskId!;
                failureResult.data = null;
                failureResult.error = JSON.stringify(errorRecord);
                await resultRepository.save(failureResult);

                task.resultId = failureResult.resultId!;
                task.status = TaskStatus.Failed;
                task.progress = null;
                await entityManager.getRepository(Task).save(task);
            });

            throw error;
        }

        const workflowRepository = this.taskRepository.manager.getRepository(Workflow);
        const currentWorkflow = await workflowRepository.findOne({ where: { workflowId: task.workflow.workflowId }, relations: ['tasks'] });

        if (currentWorkflow) {
            const allCompleted = currentWorkflow.tasks.every(t => t.status === TaskStatus.Completed);
            const anyFailed = currentWorkflow.tasks.some(t => t.status === TaskStatus.Failed);

            if (anyFailed) {
                currentWorkflow.status = WorkflowStatus.Failed;
            } else if (allCompleted) {
                currentWorkflow.status = WorkflowStatus.Completed;
            } else {
                currentWorkflow.status = WorkflowStatus.InProgress;
            }

            await workflowRepository.save(currentWorkflow);
        }
    }
}