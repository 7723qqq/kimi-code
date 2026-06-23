import type { ContentPart } from '@moonshot-ai/kosong';

import type { CronJobOrigin } from '../../../agent/context';
import { renderCronFireXml } from '../../../tools/cron/cron-fire-xml';
import { SessionCronStore, type SessionCronTaskInit } from '../../../tools/cron/session-store';
import type { CronTask } from '../../../tools/cron/types';
import { IPromptService } from '../prompt/prompt';
import { IEventBus } from '../eventBus/eventBus';
import type { ContextMessage, Turn } from '../types';

export type CronTaskInit = SessionCronTaskInit;

export interface CronFireOptions {
  readonly coalescedCount?: number;
  readonly firedAt?: number;
}

declare module '../types' {
  interface AgentEventMap {
    'cron.scheduled': {
      task: CronTask;
    };
    'cron.deleted': {
      ids: readonly string[];
    };
    'cron.fired': {
      origin: CronJobOrigin;
      prompt: string;
    };
  }
}

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export class Cron {
  private readonly store = new SessionCronStore();

  constructor(
    @IPromptService private readonly prompt: IPromptService,
    @IEventBus private readonly events: IEventBus,
  ) {}

  addTask(init: CronTaskInit): CronTask {
    const task = this.store.add(init, Date.now());
    this.events.emit({ type: 'cron.scheduled', task });
    return task;
  }

  removeTasks(ids: readonly string[]): readonly string[] {
    const removed = this.store.remove(ids);
    if (removed.length > 0) {
      this.events.emit({ type: 'cron.deleted', ids: removed });
    }
    return removed;
  }

  getTask(id: string): CronTask | undefined {
    return this.store.get(id);
  }

  list(): readonly CronTask[] {
    return this.store.list();
  }

  fire(id: string, options: CronFireOptions = {}): Turn | undefined {
    const task = this.store.get(id);
    if (task === undefined) return undefined;

    const firedAt = options.firedAt ?? Date.now();
    const stale = this.isStale(task, firedAt);
    const origin: CronJobOrigin = {
      kind: 'cron_job',
      jobId: task.id,
      cron: task.cron,
      recurring: task.recurring !== false,
      coalescedCount: options.coalescedCount ?? 1,
      stale,
    };
    const content: ContentPart[] = [
      {
        type: 'text',
        text: renderCronFireXml(origin, task.prompt),
      },
    ];
    const message: ContextMessage = {
      role: 'user',
      content,
      toolCalls: [],
      origin,
    };

    this.events.emit({ type: 'cron.fired', origin, prompt: task.prompt });
    const turn = this.prompt.steer(message);
    if (task.recurring === false || stale) {
      this.removeTasks([task.id]);
    } else {
      this.store.markFired(task.id, firedAt);
    }
    return turn;
  }

  private isStale(task: CronTask, now: number): boolean {
    if (task.recurring === false) return false;
    const age = now - task.createdAt;
    return Number.isFinite(age) && age >= STALE_THRESHOLD_MS;
  }
}
