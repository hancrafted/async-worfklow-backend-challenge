import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Workflow } from './Workflow';
import {TaskStatus} from "../workers/taskRunner";

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