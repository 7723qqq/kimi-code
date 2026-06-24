import { createDecorator } from '../../../di';
import type { ClockSources } from '../../../tools/cron/clock';
import type { SessionCronTaskInit } from '../../../tools/cron/session-store';
import type { CronTask } from '../../../tools/cron/types';

export type CronTaskInit = SessionCronTaskInit;

export interface CronPersistence {
  list(): Promise<readonly CronTask[]>;
  write(id: string, task: CronTask): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface CronOptions {
  readonly persistence?: CronPersistence;
  readonly homedir?: string;
  readonly isSubagent?: boolean;
  readonly clocks?: ClockSources;
  readonly pollIntervalMs?: number | null;
  readonly autoStart?: boolean;
  readonly registerTools?: boolean;
  readonly onPersistenceError?: (error: unknown, taskId: string) => void;
}

export interface CronLoadOptions {
  readonly replace?: boolean;
}

export interface CronFireOptions {
  readonly coalescedCount?: number;
  readonly firedAt?: number;
}

export interface ICronService {
  readonly _serviceBrand: undefined;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ICronService = createDecorator<ICronService>('agentCronService');
