import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IInteractionService } from '#/interaction/interaction';
import { InteractionService } from '#/interaction/interactionService';

describe('InteractionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IInteractionService, new SyncDescriptor(InteractionService));
  });
  afterEach(() => disposables.dispose());

  it('request blocks until respond resolves it', async () => {
    const svc = ix.get(IInteractionService);
    const pending = svc.request<{ n: number }, string>({
      kind: 'question',
      payload: { n: 1 },
    });
    expect(svc.listPending()).toHaveLength(1);

    svc.respond(svc.listPending()[0]!.id, 'ok');
    await expect(pending).resolves.toBe('ok');
    expect(svc.listPending()).toHaveLength(0);
  });

  it('uses the caller-provided id for correlation', async () => {
    const svc = ix.get(IInteractionService);
    const pending = svc.request({ id: 'tool-1', kind: 'approval', payload: {} });
    expect(svc.listPending()[0]!.id).toBe('tool-1');
    svc.respond('tool-1', { decision: 'approved' });
    await expect(pending).resolves.toEqual({ decision: 'approved' });
  });

  it('listPending filters by kind', () => {
    const svc = ix.get(IInteractionService);
    void svc.request({ kind: 'approval', payload: {} });
    void svc.request({ kind: 'question', payload: {} });
    expect(svc.listPending('approval')).toHaveLength(1);
    expect(svc.listPending('question')).toHaveLength(1);
    expect(svc.listPending()).toHaveLength(2);
  });

  it('onDidChange fires on request and on respond', async () => {
    const svc = ix.get(IInteractionService);
    let count = 0;
    disposables.add(svc.onDidChange(() => count++));
    const pending = svc.request({ kind: 'question', payload: {} });
    expect(count).toBe(1);
    svc.respond(svc.listPending()[0]!.id, 'x');
    await pending;
    expect(count).toBe(2);
  });

  it('respond to an unknown id is a no-op', () => {
    const svc = ix.get(IInteractionService);
    expect(() => svc.respond('nope', 'x')).not.toThrow();
  });
});
