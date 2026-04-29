import { Job, JobContext } from './Job';
import booleanWithin from '@turf/boolean-within';
import { Feature, Polygon } from 'geojson';
import countryMapping from '../data/world_data.json';
import * as logger from '../utils/logger';

export class DataAnalysisJob implements Job {
    async run(context: JobContext): Promise<string> {
        const { task } = context;
        const logContext = {
            workflowId: task.workflowId,
            taskId: task.taskId,
            stepNumber: task.stepNumber,
            taskType: task.taskType,
        };
        logger.info('running data analysis', logContext);

        const inputGeometry: Feature<Polygon> = JSON.parse(task.geoJson);

        for (const countryFeature of countryMapping.features) {
            if (countryFeature.geometry.type === 'Polygon' || countryFeature.geometry.type === 'MultiPolygon') {
                const isWithin = booleanWithin(inputGeometry, countryFeature as Feature<Polygon>);
                if (isWithin) {
                    logger.info(`polygon is within ${countryFeature.properties?.name}`, logContext);
                    return countryFeature.properties?.name;
                }
            }
        }
        return 'No country found';
    }
}
