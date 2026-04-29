import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Workflow } from './Workflow';

export enum TaskStatus {
    Queued = 'queued',
    Waiting = 'waiting',
    InProgress = 'in_progress',
    Completed = 'completed',
    Failed = 'failed',
    Skipped = 'skipped'
}

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
    TaskStatus.Completed,
    TaskStatus.Failed,
    TaskStatus.Skipped,
]);

@Entity({ name: 'tasks' })
export class Task {
    @PrimaryGeneratedColumn('uuid')
    taskId!: string;

    @Column()
    clientId!: string;

    @Column('text')
    geoJson!: string;

    @Column({ type: 'varchar' })
    status!: TaskStatus;

    @Column({ nullable: true, type: 'text' })
    progress?: string | null;

    @Column({ nullable: true })
    resultId?: string;

    @Column()
    taskType!: string;

    @Column({ default: 1 })
    stepNumber!: number;

    @Column({ type: 'simple-json', default: '[]' })
    dependsOn!: string[];

    @Column()
    workflowId!: string;

    @ManyToOne(() => Workflow, workflow => workflow.tasks)
    @JoinColumn({ name: 'workflowId' })
    workflow!: Workflow;
}