import { Router } from 'express';
import path from 'path';
import * as yaml from 'js-yaml';
import type { DataSource } from 'typeorm';
import { AppDataSource } from '../data-source';
import {
    WorkflowFactory,
    WorkflowValidationError,
} from '../workflows/WorkflowFactory';
import { ApiErrorCode, errorResponse } from '../utils/errorResponse';
import * as logger from '../utils/logger';

interface CreateAnalysisRouterOptions {
    dataSource: DataSource;
    workflowFile: string;
}

/**
 * Builds a `/analysis` router bound to a specific DataSource and workflow
 * YAML path. The default export wires up production defaults so callers like
 * `index.ts` keep `app.use("/analysis", analysisRoutes)` unchanged; tests use
 * `createAnalysisRouter({ dataSource, workflowFile })` to inject fixtures.
 */
export function createAnalysisRouter(
    options: CreateAnalysisRouterOptions,
): Router {
    const router = Router();
    const factory = new WorkflowFactory(options.dataSource);

    router.post('/', async (req, res) => {
        const { clientId, geoJson } = (req.body ?? {}) as {
            clientId?: unknown;
            geoJson?: unknown;
        };

        if (typeof clientId !== 'string' || clientId.length === 0) {
            errorResponse(
                res,
                400,
                ApiErrorCode.INVALID_PAYLOAD,
                'Request body is missing required `clientId`',
            );
            return;
        }
        if (geoJson === undefined || geoJson === null) {
            errorResponse(
                res,
                400,
                ApiErrorCode.INVALID_PAYLOAD,
                'Request body is missing required `geoJson`',
            );
            return;
        }

        try {
            const workflow = await factory.createWorkflowFromYAML(
                options.workflowFile,
                clientId,
                JSON.stringify(geoJson),
            );
            res.status(202).json({
                workflowId: workflow.workflowId,
                message:
                    'Workflow created and tasks queued from YAML definition.',
            });
        } catch (error) {
            if (error instanceof WorkflowValidationError) {
                errorResponse(res, 400, error.code, error.message);
                return;
            }
            if (error instanceof yaml.YAMLException) {
                errorResponse(
                    res,
                    400,
                    ApiErrorCode.INVALID_WORKFLOW_FILE,
                    `Workflow YAML failed to parse: ${error.message}`,
                );
                return;
            }
            logger.error('failed to create workflow', { error });
            res.status(500).json({ message: 'Failed to create workflow' });
        }
    });

    return router;
}

const defaultRouter = createAnalysisRouter({
    dataSource: AppDataSource,
    workflowFile: path.join(__dirname, '../workflows/example_workflow.yml'),
});

export default defaultRouter;
