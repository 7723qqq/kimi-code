import { bench, reportBenchResults } from '../../_support/bench';

import type { ISessionManager } from '#/app/sessionManager/sessionManager';
import { WorkspaceLifecycleService } from '#/app/workspaceLifecycle/workspaceLifecycleService';
import type { WorkspaceInstance } from '#/workspace/workspaceInstance/workspaceInstance';
import type {
  IWorkspaceInstanceManager,
  WorkspaceInstanceLease,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';

const counters = { acquires: 0, disposes: 0, live: 0 };

function reset(): void {
  counters.acquires = 0;
  counters.disposes = 0;
  counters.live = 0;
}

const instance = { id: 'wd-bench', root: '/wd-bench' } as unknown as WorkspaceInstance;

function stubManager(): IWorkspaceInstanceManager {
  return {
    _serviceBrand: undefined,
    acquire: async () => {
      counters.acquires += 1;
      counters.live += 1;
      let released = false;
      return {
        instance,
        dispose: () => {
          if (released) return;
          released = true;
          counters.live -= 1;
          counters.disposes += 1;
        },
      };
    },
    list: () => [],
    onDidChange: () => ({ dispose: () => {} }),
  } as unknown as IWorkspaceInstanceManager;
}

const sessions = {} as unknown as ISessionManager;

async function runNew(calls: number): Promise<void> {
  const lifecycle = new WorkspaceLifecycleService(stubManager(), sessions);
  try {
    for (let index = 0; index < calls; index += 1) {
      await lifecycle.handlerFor({ workspaceId: 'wd-bench' });
    }
  } finally {
    lifecycle.dispose();
  }
}

async function runOld(calls: number): Promise<void> {
  const manager = stubManager();
  const leases = new Map<string, WorkspaceInstanceLease>();
  for (let index = 0; index < calls; index += 1) {
    const lease = await manager.acquire({ workspaceId: 'wd-bench' });
    leases.set(lease.instance.id, lease);
  }
}

for (const calls of [100, 1_000]) {
  reset();
  await runOld(calls);
  console.log(
    `handlerFor old  n=${String(calls)} acquires=${String(counters.acquires)} disposes=${String(
      counters.disposes,
    )} netLeases=${String(counters.live)}`,
  );

  reset();
  await runNew(calls);
  console.log(
    `handlerFor new  n=${String(calls)} acquires=${String(counters.acquires)} disposes=${String(
      counters.disposes,
    )} netLeases=${String(counters.live)}`,
  );
}

const previous = {
  instance,
  dispose: () => {},
} as WorkspaceInstanceLease;
const next = {
  instance,
  dispose: () => {},
} as WorkspaceInstanceLease;
const leases = new Map<string, WorkspaceInstanceLease>([['wd-bench', previous]]);

bench('old: overwrite the lease without disposing it', () => {
  leases.set('wd-bench', next);
});

bench('new: dispose the replaced lease', () => {
  const replaced = leases.get('wd-bench');
  leases.set('wd-bench', next);
  replaced?.dispose();
});

reportBenchResults();
