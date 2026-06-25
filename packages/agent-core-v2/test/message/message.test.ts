import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IContextService } from '#/context/context';
import { ContextService } from '#/context/contextService';
import { IMessageService } from '#/message/message';
import { MessageService } from '#/message/messageService';
import { IAgentRecords } from '#/records/records';
import { stubAgentRecords } from '../records/stubs';

describe('MessageService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    // Dependencies: real ContextService (itself backed by a stubbed IAgentRecords).
    ix.stub(IAgentRecords, stubAgentRecords());
    ix.set(IContextService, new SyncDescriptor(ContextService));
    // System under test, registered by interface so the binding is exercised.
    ix.set(IMessageService, new SyncDescriptor(MessageService));
  });
  afterEach(() => disposables.dispose());

  it('projects context messages with stable derived ids', () => {
    const ctx = ix.get(IContextService);
    ctx.appendMessage({ role: 'user', content: 'a' });
    ctx.appendMessage({ role: 'assistant', content: 'b' });

    const msg = ix.get(IMessageService);
    const list = msg.list();
    expect(list).toEqual([
      { id: 'msg-0', role: 'user', content: 'a' },
      { id: 'msg-1', role: 'assistant', content: 'b' },
    ]);
    expect(msg.get('msg-1')).toEqual({ id: 'msg-1', role: 'assistant', content: 'b' });
    expect(msg.get('missing')).toBeUndefined();
  });
});
