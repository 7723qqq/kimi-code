export type SwarmPhase = 'planning' | 'working' | 'synthesizing' | 'done' | 'cancelled';
export type WorkerStatus = 'running' | 'done' | 'failed' | 'retrying';

export interface WorkerRow {
  id: string;
  role: string;
  status: WorkerStatus;
  toolCount: number;
  latestActivity?: string;
  tokens?: number;
  error?: string;
}

export interface SwarmModel {
  task: string;
  phase: SwarmPhase;
  total: number;
  doneCount: number;
  failedCount: number;
  workers: Map<string, WorkerRow>;
}

export type SwarmEvent =
  | { t: 'planned'; total: number }
  | { t: 'synthesizing' }
  | { t: 'done'; succeeded: number; failed: number }
  | { t: 'cancelled' }
  | { t: 'worker.spawned'; id: string; role: string }
  | { t: 'worker.toolcall'; id: string; activity: string }
  | { t: 'worker.tokens'; id: string; tokens: number }
  | { t: 'worker.done'; id: string; tokens?: number }
  | { t: 'worker.failed'; id: string; error: string };

export function initialSwarmModel(task: string): SwarmModel {
  return { task, phase: 'planning', total: 0, doneCount: 0, failedCount: 0, workers: new Map() };
}

export function applySwarmEvent(model: SwarmModel, event: SwarmEvent): SwarmModel {
  switch (event.t) {
    case 'planned':
      return { ...model, phase: 'working', total: event.total };
    case 'synthesizing':
      return { ...model, phase: 'synthesizing' };
    case 'done':
      return { ...model, phase: 'done' };
    case 'cancelled':
      return { ...model, phase: 'cancelled' };
    case 'worker.spawned': {
      const workers = new Map(model.workers);
      if (!workers.has(event.id)) {
        workers.set(event.id, { id: event.id, role: event.role, status: 'running', toolCount: 0 });
      }
      return { ...model, workers };
    }
    case 'worker.toolcall': {
      const workers = new Map(model.workers);
      const w = workers.get(event.id);
      if (w !== undefined) {
        workers.set(event.id, { ...w, toolCount: w.toolCount + 1, latestActivity: event.activity });
      }
      return { ...model, workers };
    }
    case 'worker.tokens': {
      const w = model.workers.get(event.id);
      if (w === undefined) return model;
      const workers = new Map(model.workers);
      workers.set(event.id, { ...w, tokens: event.tokens });
      return { ...model, workers };
    }
    case 'worker.done': {
      const workers = new Map(model.workers);
      const w = workers.get(event.id);
      if (w === undefined) return model;
      const wasTerminal = w.status === 'done' || w.status === 'failed';
      workers.set(event.id, {
        ...w,
        status: 'done',
        latestActivity: undefined,
        ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
      });
      return { ...model, workers, doneCount: wasTerminal ? model.doneCount : model.doneCount + 1 };
    }
    case 'worker.failed': {
      const workers = new Map(model.workers);
      const w = workers.get(event.id);
      if (w === undefined) return model;
      const wasTerminal = w.status === 'done' || w.status === 'failed';
      workers.set(event.id, { ...w, status: 'failed', latestActivity: undefined, error: event.error });
      return { ...model, workers, failedCount: wasTerminal ? model.failedCount : model.failedCount + 1 };
    }
    default:
      return model;
  }
}

export function workerActivityFromTool(name: string, args: Record<string, unknown>): string {
  const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  switch (name) {
    case 'Read': {
      const p = s(args['path']);
      return p !== undefined ? `read ${p}` : 'read';
    }
    case 'Grep': {
      const p = s(args['pattern']);
      return p !== undefined ? `grep "${p}"` : 'grep';
    }
    case 'Glob': {
      const p = s(args['pattern']);
      return p !== undefined ? `glob ${p}` : 'glob';
    }
    case 'WebSearch': {
      const q = s(args['query']);
      return q !== undefined ? `search "${q}"` : 'search';
    }
    case 'FetchURL': {
      const u = s(args['url']);
      return u !== undefined ? `fetch ${u}` : 'fetch';
    }
    default:
      return name;
  }
}
