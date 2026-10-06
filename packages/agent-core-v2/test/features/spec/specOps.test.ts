import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import {
  SpecModeCancel,
  SpecModeEnter,
  SpecModeExit,
  SpecRevision,
  specKey,
} from '#/features/spec/specOps';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import type { IEventDispatcher } from '#/state/eventDispatcher';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import type { IWireService } from '#/wire/wire';

import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

const SCOPE = 'wire';
const KEY = 'spec-test';
const AGENT = 'test-agent';

let disposables: DisposableStore;
let dispatcher: IEventDispatcher;
let agentState: IAgentStateService;
let log: IAppendLogStore;
let statusUpdates: boolean[];

function buildHost(key: string): {
  wire: IWireService;
  dispatcher: IEventDispatcher;
  agentState: IAgentStateService;
  log: IAppendLogStore;
  eventBus: IEventBus;
} {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  const wire = registerTestAgentWire(ix, testWireScope(SCOPE, key), {
    log: ix.get(IAppendLogStore),
    eventBus: ix.get(IEventBus),
  });
  const dispatcher = registerTestEventDispatcher(ix);
  const agentState = ix.get(IAgentStateService);
  agentState.contributeState(specKey);
  return {
    wire,
    dispatcher,
    agentState,
    log: ix.get(IAppendLogStore),
    eventBus: ix.get(IEventBus),
  };
}

beforeEach(() => {
  disposables = new DisposableStore();
  statusUpdates = [];
  const host = buildHost(KEY);
  dispatcher = host.dispatcher;
  agentState = host.agentState;
  log = host.log;
  host.eventBus.subscribe(AgentStatusUpdated, (event) => {
    statusUpdates.push(event.specMode === true);
  });
});

afterEach(() => disposables.dispose());

async function readRecords(): Promise<WireRecord[]> {
  await dispatcher.flush();
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(
    testWireScope(SCOPE, KEY),
    AGENT_WIRE_RECORD_KEY,
  )) {
    out.push(record);
  }
  return out;
}

describe('spec ops (wire-backed)', () => {
  it('records an exit as the last transition', async () => {
    await dispatcher.dispatch(new SpecModeEnter({ agentId: AGENT, id: 's1' }));
    await dispatcher.dispatch(new SpecModeExit({ agentId: AGENT, id: 's1' }));

    expect(agentState.get(specKey).active).toBe(false);
    expect(agentState.get(specKey).lastTransition).toBe('exit');
  });

  it('records a cancel as the last transition', async () => {
    await dispatcher.dispatch(new SpecModeEnter({ agentId: AGENT, id: 's1' }));
    await dispatcher.dispatch(new SpecModeCancel({ agentId: AGENT, id: 's1' }));

    expect(agentState.get(specKey).active).toBe(false);
    expect(agentState.get(specKey).lastTransition).toBe('cancel');
  });

  it('distinguishes an exit from a cancel in the persisted record stream', async () => {
    await dispatcher.dispatch(new SpecModeEnter({ agentId: AGENT, id: 's1' }));
    await dispatcher.dispatch(new SpecModeCancel({ agentId: AGENT, id: 's1' }));
    await dispatcher.dispatch(new SpecModeEnter({ agentId: AGENT, id: 's2' }));
    await dispatcher.dispatch(new SpecModeExit({ agentId: AGENT, id: 's2' }));

    const records = await readRecords();
    expect(records.map((record) => record.type)).toEqual([
      'spec_mode.enter',
      'spec_mode.cancel',
      'spec_mode.enter',
      'spec_mode.exit',
    ]);
  });

  it('keeps the last transition across a re-entry', async () => {
    await dispatcher.dispatch(new SpecModeEnter({ agentId: AGENT, id: 's1' }));
    await dispatcher.dispatch(new SpecModeExit({ agentId: AGENT, id: 's1' }));
    await dispatcher.dispatch(new SpecModeEnter({ agentId: AGENT, id: 's2' }));

    expect(agentState.get(specKey).active).toBe(true);
    expect(agentState.get(specKey).lastTransition).toBe('exit');
  });

  it('emits one status update per termination', async () => {
    await dispatcher.dispatch(new SpecModeEnter({ agentId: AGENT, id: 's1' }));
    await dispatcher.dispatch(new SpecModeCancel({ agentId: AGENT, id: 's1' }));
    await dispatcher.dispatch(new SpecModeEnter({ agentId: AGENT, id: 's2' }));
    await dispatcher.dispatch(new SpecModeExit({ agentId: AGENT, id: 's2' }));

    expect(statusUpdates).toEqual([true, false, true, false]);
  });

  it('does not record a transition when cancel arrives while the spec is inactive', async () => {
    await dispatcher.dispatch(new SpecModeCancel({ agentId: AGENT }));

    expect(agentState.get(specKey).lastTransition).toBeUndefined();
  });

  it('still tracks revision counts', async () => {
    await dispatcher.dispatch(new SpecModeEnter({ agentId: AGENT, id: 's1' }));
    await dispatcher.dispatch(
      new SpecRevision({
        agentId: AGENT,
        id: 's1',
        version: 2,
        key: 'spec/s1/v2.md',
        sha256: 'abc',
        bytes: 3,
      }),
    );

    expect(agentState.get(specKey).revisionCount?.['s1']).toBe(2);
  });
});
