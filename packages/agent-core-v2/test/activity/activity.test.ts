/**
 * `activity` kernel unit tests — drives the real `AgentActivityService` with a
 * stub Session kernel and an in-memory wire service.
 *
 * Asserts the PR1 turn-lane contract: `begin` admits a turn and rejects a
 * concurrent one with `activity.agent_busy`, `cancel` moves the lane to
 * `turn(ending)` and aborts the lease signal, and `lease.end` returns the lane
 * to `idle` (idempotently). Run:
 * `pnpm test -- test/activity/activity.test.ts`
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, TestInstantiationService } from '#/_base/di/test';
import { IAgentActivityService, ISessionActivityKernel } from '#/activity/activity';
import { AgentActivityService } from '#/activity/agentActivityService';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ErrorCodes } from '#/errors';
import { IAgentWireService } from '#/wire/tokens';
import { WireService } from '#/wire/wireServiceImpl';

import { stubSessionActivityKernel } from './stubs';

describe('AgentActivityService (turn lane)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let activity: IAgentActivityService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(
          IAgentWireService,
          disposables.add(new WireService({ logScope: 'wire', logKey: 'activity' })),
        );
        reg.defineInstance(ISessionActivityKernel, stubSessionActivityKernel());
        reg.defineInstance(
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'agent', agentScope: 'agent' }),
        );
        reg.define(IAgentActivityService, AgentActivityService);
      },
    });
    activity = ix.get(IAgentActivityService);
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('starts idle and admits a turn', () => {
    expect(activity.lane()).toBe('idle');
    const lease = activity.begin('turn');
    expect(lease.kind).toBe('turn');
    expect(lease.signal.aborted).toBe(false);
    expect(activity.lane()).toBe('turn');
    lease.end('completed');
    expect(activity.lane()).toBe('idle');
  });

  it('rejects a concurrent begin with activity.agent_busy', () => {
    const lease = activity.begin('turn');
    expect(() => activity.begin('turn')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.ACTIVITY_AGENT_BUSY }),
    );
    lease.end('completed');
  });

  it('tryBegin returns undefined when busy', () => {
    const lease = activity.begin('turn');
    expect(activity.tryBegin('turn')).toBeUndefined();
    lease.end('completed');
  });

  it('cancel aborts the lease signal and keeps the lane until end', () => {
    const lease = activity.begin('turn');
    expect(activity.cancel('stop')).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.ending).toBe(true);
    // Lane stays `turn` (ending) until the lease is returned.
    expect(activity.lane()).toBe('turn');
    lease.end('cancelled');
    expect(activity.lane()).toBe('idle');
  });

  it('cancel is a no-op when idle', () => {
    expect(activity.cancel()).toBe(false);
  });

  it('lease.end is idempotent', () => {
    const lease = activity.begin('turn');
    lease.end('completed');
    expect(() => lease.end('completed')).not.toThrow();
    expect(activity.lane()).toBe('idle');
  });

  it('beginDisposal aborts the in-flight lease and settles after end', async () => {
    const lease = activity.begin('turn');
    activity.beginDisposal();
    expect(lease.signal.aborted).toBe(true);
    expect(activity.lane()).toBe('disposing');
    const settled = activity.settled();
    lease.end('cancelled');
    await settled;
    expect(activity.lane()).toBe('disposed');
  });
});
