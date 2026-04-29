import * as path from "path";
import type { DataSource } from "typeorm";
import { WorkflowFactory } from "../../../src/workflows/WorkflowFactory";
import type { Workflow } from "../../../src/models/Workflow";
import { Task } from "../../../src/models/Task";

const DEFAULT_CLIENT_ID = "test-client";
const DEFAULT_GEOJSON: object = {
  type: "Polygon",
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
};

/**
 * Wraps `WorkflowFactory.createWorkflowFromYAML(...)` for a fixture under
 * `tests/03-interdependent-tasks/fixtures/`. Returns the persisted workflow
 * plus the freshly-loaded tasks (the factory only returns the workflow root).
 */
export async function seedWorkflow(
  dataSource: DataSource,
  fixtureFileName: string,
  opts: { clientId?: string; geoJson?: object } = {},
): Promise<{ workflow: Workflow; tasks: Task[] }> {
  const clientId = opts.clientId ?? DEFAULT_CLIENT_ID;
  const geoJson = opts.geoJson ?? DEFAULT_GEOJSON;
  const fixturePath = path.join(__dirname, "..", "fixtures", fixtureFileName);

  const factory = new WorkflowFactory(dataSource);
  const workflow = await factory.createWorkflowFromYAML(
    fixturePath,
    clientId,
    JSON.stringify(geoJson),
  );

  const tasks = await dataSource
    .getRepository(Task)
    .find({ where: { workflowId: workflow.workflowId } });

  return { workflow, tasks };
}
