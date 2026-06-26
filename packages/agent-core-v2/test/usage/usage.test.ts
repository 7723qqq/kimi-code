import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IEventSink } from '../../src/eventSink';
import { IUsageService } from '#/usage';
import { UsageService } from '#/usage/usageService';
import { IWireRecord } from '#/wireRecord';

import { stubWireRecord } from '../contextMemory/stubs';

function usage(inputOther: number, output: number): { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number } {
  return { inputOther, output, inputCacheRead: 0, inputCacheCreation: 0 };
}

describe('UsageService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IWireRecord, stubWireRecord());
    ix.stub(IEventSink, { emit: () => {}, on: () => toDisposable(() => {}) });
    ix.set(IUsageService, new SyncDescriptor(UsageService));
  });
  afterEach(() => disposables.dispose());

  it('accumulates input/output tokens per model', () => {
    const svc = ix.get(IUsageService);
    svc.record('m', usage(10, 5));
    svc.record('m', usage(3, 2));
    expect(svc.status().byModel?.['m']).toEqual(usage(13, 7));
    expect(svc.status().total).toEqual(usage(13, 7));
  });

  it('tracks current turn usage by turn id', () => {
    const svc = ix.get(IUsageService);
    svc.record('m', usage(10, 5), { type: 'turn', turnId: 1 });
    svc.record('m', usage(3, 2), { type: 'turn', turnId: 1 });
    expect(svc.status().currentTurn).toEqual(usage(13, 7));

    svc.record('m', usage(4, 1), { type: 'turn', turnId: 2 });
    expect(svc.status().currentTurn).toEqual(usage(4, 1));
  });

  it('does not include session usage in current turn', () => {
    const svc = ix.get(IUsageService);
    svc.record('m', usage(10, 5), { type: 'turn', turnId: 1 });
    svc.record('m', usage(3, 2));
    expect(svc.status().currentTurn).toEqual(usage(10, 5));
    expect(svc.status().byModel?.['m']).toEqual(usage(13, 7));
  });
});
