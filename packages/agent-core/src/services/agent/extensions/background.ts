import { randomBytes } from 'node:crypto';

import {
  TERMINAL_STATUSES,
  type BackgroundTask,
  type BackgroundTaskInfo,
  type BackgroundTaskInfoBase,
  type BackgroundTaskSettlement,
  type BackgroundTaskStatus,
} from '../../../agent/background/task';

import { IEventBus } from '../eventBus/eventBus';

export interface BackgroundTaskOutputSnapshot {
  readonly outputSizeBytes: number;
  readonly previewBytes: number;
  readonly truncated: boolean;
  readonly fullOutputAvailable: boolean;
  readonly preview: string;
}

declare module '../types' {
  interface AgentEventMap {
    'background.task.started': {
      info: BackgroundTaskInfo;
    };
    'background.task.terminated': {
      info: BackgroundTaskInfo;
    };
  }
}

interface ManagedTask {
  readonly taskId: string;
  readonly task: BackgroundTask;
  readonly outputChunks: string[];
  outputSizeBytes: number;
  status: BackgroundTaskStatus;
  readonly startedAt: number;
  endedAt: number | null;
  stopReason?: string;
  readonly abortController: AbortController;
  lifecyclePromise: Promise<void>;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  readonly waiters: Array<() => void>;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
const SIGTERM_GRACE_MS = 5_000;
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export class Background {
  private readonly tasks = new Map<string, ManagedTask>();

  constructor(@IEventBus private readonly events: IEventBus) {}

  registerTask(task: BackgroundTask): string {
    const entry: ManagedTask = {
      taskId: generateTaskId(task.idPrefix),
      task,
      outputChunks: [],
      outputSizeBytes: 0,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      abortController: new AbortController(),
      lifecyclePromise: Promise.resolve(),
      waiters: [],
    };
    this.tasks.set(entry.taskId, entry);

    if (task.timeoutMs !== undefined) {
      entry.timeoutHandle = setTimeout(() => {
        entry.abortController.abort('timed out');
        void this.settleTask(entry, { status: 'timed_out', stopReason: 'timed out' });
      }, task.timeoutMs);
    }

    entry.lifecyclePromise = Promise.resolve()
      .then(() =>
        task.start({
          signal: entry.abortController.signal,
          appendOutput: (chunk) => {
            this.appendOutput(entry, chunk);
          },
          settle: (settlement) => this.settleTask(entry, settlement),
        }),
      )
      .catch(async (error: unknown) => {
        const status = entry.abortController.signal.aborted ? 'killed' : 'failed';
        await this.settleTask(entry, {
          status,
          stopReason: status === 'failed' ? errorMessage(error) : undefined,
        });
      });

    this.events.emit({ type: 'background.task.started', info: this.toInfo(entry) });
    return entry.taskId;
  }

  getTask(taskId: string): BackgroundTaskInfo | undefined {
    const entry = this.tasks.get(taskId);
    return entry === undefined ? undefined : this.toInfo(entry);
  }

  list(activeOnly = true, limit?: number): readonly BackgroundTaskInfo[] {
    const result: BackgroundTaskInfo[] = [];
    for (const entry of this.tasks.values()) {
      if (activeOnly && TERMINAL_STATUSES.has(entry.status)) continue;
      result.push(this.toInfo(entry));
      if (limit !== undefined && result.length >= limit) return result;
    }
    return result;
  }

  async getOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<BackgroundTaskOutputSnapshot> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) {
      return {
        outputSizeBytes: 0,
        previewBytes: 0,
        truncated: false,
        fullOutputAvailable: false,
        preview: '',
      };
    }

    const output = entry.outputChunks.join('');
    const available = Buffer.from(output, 'utf-8');
    const previewLimit = Math.max(0, Math.trunc(maxPreviewBytes));
    const previewBytes = Math.min(previewLimit, available.byteLength, entry.outputSizeBytes);
    const previewOffset = available.byteLength - previewBytes;
    return {
      outputSizeBytes: entry.outputSizeBytes,
      previewBytes,
      truncated: entry.outputSizeBytes > previewBytes,
      fullOutputAvailable: false,
      preview: available.subarray(previewOffset).toString('utf-8'),
    };
  }

  async readOutput(taskId: string, tail?: number): Promise<string> {
    const output = (await this.getOutputSnapshot(taskId, Number.MAX_SAFE_INTEGER)).preview;
    if (tail !== undefined && tail < output.length) {
      return output.slice(-tail);
    }
    return output;
  }

  async stop(taskId: string, reason?: string): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return undefined;
    if (TERMINAL_STATUSES.has(entry.status)) return this.toInfo(entry);

    const stopReason = normalizeReason(reason);
    entry.stopReason = stopReason;
    entry.abortController.abort(stopReason);

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const graceful = await Promise.race([
      entry.lifecyclePromise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        graceTimer = setTimeout(() => {
          resolve(false);
        }, SIGTERM_GRACE_MS);
      }),
    ]);
    if (graceTimer !== undefined) clearTimeout(graceTimer);

    if (TERMINAL_STATUSES.has(entry.status)) return this.toInfo(entry);

    if (!graceful) {
      await entry.task.forceStop?.();
    }

    if (TERMINAL_STATUSES.has(entry.status)) return this.toInfo(entry);
    await this.settleTask(entry, { status: 'killed', stopReason });
    return this.toInfo(entry);
  }

  async stopAll(reason?: string): Promise<readonly BackgroundTaskInfo[]> {
    const results = await Promise.all(
      Array.from(this.tasks.keys()).map((taskId) => this.stop(taskId, reason)),
    );
    return results.filter((info): info is BackgroundTaskInfo => info !== undefined);
  }

  async wait(taskId: string, timeoutMs = 30_000): Promise<BackgroundTaskInfo | undefined> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) return undefined;
    if (TERMINAL_STATUSES.has(entry.status)) return this.toInfo(entry);

    let waiter: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          waiter = resolve;
          entry.waiters.push(resolve);
        }),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (waiter !== undefined) {
        const index = entry.waiters.indexOf(waiter);
        if (index !== -1) entry.waiters.splice(index, 1);
      }
    }
    return this.toInfo(entry);
  }

  private appendOutput(entry: ManagedTask, chunk: string): void {
    entry.outputChunks.push(chunk);
    entry.outputSizeBytes += Buffer.byteLength(chunk, 'utf-8');
    while (Buffer.byteLength(entry.outputChunks.join(''), 'utf-8') > MAX_OUTPUT_BYTES) {
      entry.outputChunks.shift();
    }
  }

  private async settleTask(
    entry: ManagedTask,
    settlement: BackgroundTaskSettlement,
  ): Promise<boolean> {
    if (TERMINAL_STATUSES.has(entry.status)) return false;
    entry.status = settlement.status;
    entry.endedAt = Date.now();
    entry.stopReason =
      settlement.stopReason ?? (settlement.status === 'killed' ? entry.stopReason : undefined);
    if (entry.timeoutHandle !== undefined) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = undefined;
    }
    this.resolveWaiters(entry);
    this.events.emit({ type: 'background.task.terminated', info: this.toInfo(entry) });
    return true;
  }

  private resolveWaiters(entry: ManagedTask): void {
    const waiters = entry.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private toInfo(entry: ManagedTask): BackgroundTaskInfo {
    const base: BackgroundTaskInfoBase = {
      taskId: entry.taskId,
      description: entry.task.description,
      status: entry.status,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      stopReason: entry.stopReason,
      timeoutMs: entry.task.timeoutMs,
    };
    return entry.task.toInfo(base);
  }
}

function generateTaskId(kind: string): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let index = 0; index < 8; index++) {
    suffix += TASK_ID_ALPHABET[bytes[index]! % TASK_ID_ALPHABET.length];
  }
  return `${kind}-${suffix}`;
}

function normalizeReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
