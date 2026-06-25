import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { CompactionService } from '#/compaction/compactionService';
import { ISessionConfigService } from '#/config';
import { IContextService } from '#/context';
import { ContextService } from '#/context/contextService';
import { IInjectionService } from '#/injection';
import { InjectionService } from '#/injection/injectionService';
import { IAgentRecords } from '#/records';
import { stubAgentRecords } from '../records/stubs';
import { ITelemetryService } from '#/telemetry';
import { ITurnService } from '#/turn';
import { stubTurn } from '../turn/stubs';

describe('CompactionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentRecords, stubAgentRecords());
    ix.stub(ISessionConfigService, {});
    ix.stub(ITelemetryService, {});
    ix.stub(ITurnService, stubTurn());
    ix.set(IContextService, new SyncDescriptor(ContextService));
    ix.set(IInjectionService, new SyncDescriptor(InjectionService));
  });
  afterEach(() => disposables.dispose());

  // NOTE: CompactionService is built via createInstance (not get) because each
  // test needs a different token threshold — a static argument the container
  // cannot bake into a singleton. See di-testing.md "Exceptions".
  it('injects a compaction summary when token usage exceeds the threshold', async () => {
    const ctx = ix.get(IContextService);
    ctx.appendMessage({ role: 'user', content: 'x'.repeat(100) });
    const injection = ix.get(IInjectionService);
    ix.createInstance(CompactionService, 10);
    const turn = ix.get(ITurnService);
    await turn.prompt('go');
    expect(injection.flush()).toEqual([
      { kind: 'compaction_summary', content: 'context overflow — compact pending' },
    ]);
  });

  it('does nothing below the threshold', async () => {
    const ctx = ix.get(IContextService);
    ctx.appendMessage({ role: 'user', content: 'hi' });
    const injection = ix.get(IInjectionService);
    ix.createInstance(CompactionService, 10_000);
    const turn = ix.get(ITurnService);
    await turn.prompt('go');
    expect(injection.flush()).toEqual([]);
  });
});
