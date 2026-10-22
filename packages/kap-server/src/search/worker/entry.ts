import { writeSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

import { configureTextBuildWorkerRuntime } from '@moonshot-ai/minidb/worker-runtime';

import { GlobalSearchError, type GlobalSearchErrorReason } from '../contract.ts';
import { SearchIndexCore, type CoreSearchParams, type SyncSessionInput } from '../indexCore.ts';
import {
  SEARCH_WORKER_PROTOCOL_VERSION,
  type SearchWorkerData,
  type SearchWorkerErrorPayload,
  type SearchWorkerEvent,
  type SearchWorkerOpenResult,
  type SearchWorkerCall,
  type SearchWorkerRequest,
} from './protocol.ts';

const scope = globalThis as unknown as {
  postMessage: (value: unknown) => void;
  getEnvironmentData?: (key?: string) => unknown;
  onmessage: ((event: { data: unknown }) => void) | null;
};

const port = parentPort;

const queued: unknown[] = [];

let deliver: (message: unknown) => void = (message) => {
  queued.push(message);
};

if (port === null) {
  scope.onmessage = (event) => {
    deliver(event.data);
  };
} else {
  port.on('message', (message: unknown) => {
    deliver(message);
  });
}

const initial = (scope.getEnvironmentData?.() ?? workerData) as SearchWorkerData | undefined;

const data = await (initial ??
  new Promise<SearchWorkerData>((resolve) => {
    deliver = (message) => {
      const value = message as { type?: string; params?: unknown } | null;
      if (value !== null && typeof value === 'object' && value.type === 'init') {
        resolve(value.params as SearchWorkerData);
        return;
      }
      queued.push(value);
    };
  }));

if (data === undefined || data === null) {
  throw new Error('search worker entry is missing its bootstrap data');
}

if (typeof data.textBuildWorkerPath === 'string') {
  try {
    configureTextBuildWorkerRuntime(data.textBuildWorkerPath);
  } catch {}
}

const post = (event: SearchWorkerEvent): void => {
  try {
    if (port === null) scope.postMessage(event);
    else port.postMessage(event);
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    writeSync(2, `search worker failed to deliver a ${event.type} event: ${detail}\n`);
    process.exit(1);
  }
};

const core = new SearchIndexCore({
  indexDir: data.dir,
  bootSalt: data.bootSalt,
  log: {
    info: (message, meta) => {
      post({ type: 'log', level: 'info', message, meta });
    },
    warn: (message, meta) => {
      post({ type: 'log', level: 'warn', message, meta });
    },
  },
  onLockToken: (token) => {
    post({ type: 'lockToken', token });
  },
});
if (typeof data.syncSessionCap === 'number') core.syncSessionCap = data.syncSessionCap;

function toErrorPayload(error: unknown): SearchWorkerErrorPayload {
  if (error instanceof GlobalSearchError) {
    return { message: error.message, reason: error.reason as GlobalSearchErrorReason };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

async function dispatch(request: SearchWorkerCall): Promise<unknown> {
  switch (request.type) {
    case 'open': {
      await core.ensureOpen();
      const result: SearchWorkerOpenResult = {
        readOnly: core.db?.readOnly === true,
        lockToken: core.lockTokenView,
        lifecycle: core.lifecycleState(),
      };
      return result;
    }
    case 'search':
      return core.search(request.params as CoreSearchParams);
    case 'sync':
      return core.sync((request.params as { sessions: readonly SyncSessionInput[] }).sessions);
    case 'refresh': {
      await core.refresh();
      const result: SearchWorkerOpenResult = {
        readOnly: core.db?.readOnly === true,
        lockToken: core.lockTokenView,
        lifecycle: core.lifecycleState(),
      };
      return result;
    }
    case 'reindex': {
      await core.reindex();
      const result: SearchWorkerOpenResult = {
        readOnly: core.db?.readOnly === true,
        lockToken: core.lockTokenView,
        lifecycle: core.lifecycleState(),
      };
      return result;
    }
    case 'status':
      return core.status();
    case 'close':
      return null;
  }
}

const inFlight = new Set<Promise<void>>();
let closing = false;

const CLOSE_DRAIN_BUDGET_MS = 2_000;

async function settleInFlight(budgetMs: number): Promise<void> {
  if (inFlight.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(inFlight),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function handle(request: SearchWorkerCall): Promise<void> {
  if (request.v !== SEARCH_WORKER_PROTOCOL_VERSION) {
    post({
      id: request.id,
      type: 'error',
      error: {
        message: `search worker protocol mismatch: host v${request.v}, worker v${SEARCH_WORKER_PROTOCOL_VERSION}`,
      },
    });
    return;
  }
  if (request.type === 'close') {
    closing = true;
    core.beginClose();
    await settleInFlight(CLOSE_DRAIN_BUDGET_MS);
    let error: SearchWorkerErrorPayload | null = null;
    try {
      await core.close();
    } catch (closeError) {
      error = toErrorPayload(closeError);
    }
    if (error !== null) post({ id: request.id, type: 'error', error });
    else post({ id: request.id, type: 'result', result: null });
    process.exit(0);
  }
  if (closing) {
    post({
      id: request.id,
      type: 'error',
      error: { message: 'search service is disposed', reason: 'index_unavailable' },
    });
    return;
  }
  try {
    const result = await dispatch(request);
    post({ id: request.id, type: 'result', result });
  } catch (error) {
    post({ id: request.id, type: 'error', error: toErrorPayload(error) });
  }
}

const accept = (value: unknown): void => {
  const request = value as SearchWorkerRequest;
  if (request === null || typeof request !== 'object') return;
  if (request.type === 'beginClose') {
    closing = true;
    core.beginClose();
    return;
  }
  if (typeof request.id !== 'number' || typeof request.type !== 'string') return;
  if (request.type === 'close') {
    void handle(request).catch(() => {});
    return;
  }
  const tracked = handle(request);
  inFlight.add(tracked);
  void tracked.finally(() => {
    inFlight.delete(tracked);
  });
};

deliver = accept;

post({ type: 'ready', v: SEARCH_WORKER_PROTOCOL_VERSION });

for (const message of queued.splice(0)) accept(message);
