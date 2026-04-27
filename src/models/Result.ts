import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity({name: 'results'})
export class Result {
    @PrimaryGeneratedColumn('uuid')
    resultId!: string;

    @Column()
    taskId!: string;

    @Column('text', { nullable: true })
    data!: string | null; // Could be JSON or any serialized format

    @Column('text', { nullable: true })
    error!: string | null; // JSON-stringified { message, reason, stack } on job failure
}