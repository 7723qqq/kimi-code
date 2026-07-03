/**
 * `cron` domain (L5) — `ICronTaskStore` contract.
 *
 * Project-level persistence catalog for cron tasks. Stores tasks under
 * `bootstrap.scope('cron')` as atomic documents keyed by
 * `<workspaceId>/<taskId>.json`. Provides CRUD and query-by-workspace.
 * The store is a pure data layer — scheduling, timers, and fire delivery
 * are owned by `ISessionCronService` at Session scope. Bound at App scope.
 */

import { createDecorator } from '#/_base/di';

import type { CronTask } from './cronTask';

export interface CronTaskQuery {
  readonly workspaceId: string;
}

export interface ICronTaskStore {
  readonly _serviceBrand: undefined;
  get(workspaceId: string, taskId: string): Promise<CronTask | undefined>;
  list(query: CronTaskQuery): Promise<readonly CronTask[]>;
  save(workspaceId: string, task: CronTask): Promise<void>;
  delete(workspaceId: string, taskId: string): Promise<void>;
}

export const ICronTaskStore = createDecorator<ICronTaskStore>('cronTaskStore');
