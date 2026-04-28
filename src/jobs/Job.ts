import { Task } from "../models/Task";

export interface JobDependencyOutput {
    stepNumber: number;
    taskType: string;
    taskId: string;
    output: unknown;
}

export interface JobContext {
    task: Task;
    dependencies: JobDependencyOutput[];
}

export interface Job {
    run(context: JobContext): Promise<unknown>;
}