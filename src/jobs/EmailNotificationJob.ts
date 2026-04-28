import { Job, JobContext } from './Job';

export class EmailNotificationJob implements Job {
    async run(context: JobContext): Promise<void> {
        const { task } = context;
        console.log(`Sending email notification for task ${task.taskId}...`);
        // Perform notification work
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log('Email sent!');
    }
}