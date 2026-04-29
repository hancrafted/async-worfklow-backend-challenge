import { Job, JobContext } from './Job';
import * as logger from '../utils/logger';

export class EmailNotificationJob implements Job {
    async run(context: JobContext): Promise<void> {
        const { task } = context;
        const logContext = {
            workflowId: task.workflowId,
            taskId: task.taskId,
            stepNumber: task.stepNumber,
            taskType: task.taskType,
        };
        logger.info('sending email notification', logContext);
        // Perform notification work
        await new Promise(resolve => setTimeout(resolve, 1000));
        logger.info('email sent', logContext);
    }
}
