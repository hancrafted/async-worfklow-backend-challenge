import { DataSource } from 'typeorm';
import { Task } from './models/Task';
import { Result } from './models/Result';
import { Workflow } from './models/Workflow';

const PRODUCTION_DATABASE_PATH = 'data/database.sqlite';
const SQLITE_BUSY_TIMEOUT_MS = 5000;

export interface BuildDataSourceOptions {
    databasePath?: string;
    dropSchema?: boolean;
    synchronize?: boolean;
}

/**
 * Builds a sqlite-backed DataSource with WAL mode + a 5s busy_timeout enabled
 * per-connection (Issue #17 Wave 1). TypeORM's sqlite driver runs
 * `PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout = ...` against every
 * fresh connection inside the post-create lifecycle hook (the documented
 * fallback for `extra.afterCreateConnection` per the locked decision — sqlite3
 * has no `prepareDatabase` hook, only better-sqlite3 does). WAL lets multiple
 * per-worker DataSources read concurrently while writers serialise at the
 * SQLite layer instead of corrupting JS-level transaction state on a shared
 * connection.
 *
 * Defaults (`dropSchema: false`, `synchronize: false`) match the per-worker
 * profile; `buildAppDataSource` overrides `synchronize` to keep the
 * bootstrap-side default that owns the schema.
 */
function buildDataSource(options: BuildDataSourceOptions = {}): DataSource {
    return new DataSource({
        type: 'sqlite',
        database: options.databasePath ?? PRODUCTION_DATABASE_PATH,
        dropSchema: options.dropSchema ?? false,
        entities: [Task, Result, Workflow],
        synchronize: options.synchronize ?? false,
        logging: false,
        enableWAL: true,
        busyTimeout: SQLITE_BUSY_TIMEOUT_MS,
    });
}

/**
 * Bootstrap-side DataSource. Defaults `synchronize: true` so the boot site
 * owns schema creation; callers opt into `dropSchema: true` for the
 * fresh-DB-on-restart guarantee (PRD §General).
 */
export function buildAppDataSource(options: BuildDataSourceOptions = {}): DataSource {
    return buildDataSource({
        ...options,
        synchronize: options.synchronize ?? true,
    });
}

/**
 * Per-worker DataSource for the production worker pool (Issue #17 Wave 1).
 * Connects to the same file-backed SQLite as the bootstrap DataSource but
 * never owns schema lifecycle (`dropSchema: false`, `synchronize: false`) —
 * the bootstrap DataSource in `index.ts` is the sole schema author.
 */
export function buildWorkerDataSource(databasePath: string = PRODUCTION_DATABASE_PATH): DataSource {
    return buildDataSource({
        databasePath,
        dropSchema: false,
        synchronize: false,
    });
}

/**
 * Production bootstrap DataSource. `dropSchema: true` so each fresh boot
 * starts from an empty DB (PRD §General — Fresh SQLite DB on every restart).
 * Used by Express routes (`/analysis`) and the production worker-pool boot
 * site in `src/index.ts`.
 */
export const AppDataSource = buildAppDataSource({ dropSchema: true });
