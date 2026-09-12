import { describe, expect, it, vi } from 'vitest';

import { SDKRpcClientBase } from '../src/rpc';
import { Session } from '../src/session';

class CapturingRpc extends SDKRpcClientBase {
  readonly promptCalls: unknown[] = [];
  readonly enterPlanCalls: unknown[] = [];
  readonly cancelPlanCalls: unknown[] = [];
  readonly getPlanCalls: unknown[] = [];
  readonly clearPlanCalls: unknown[] = [];
  readonly setModelCalls: unknown[] = [];
  private getRpcDelay: Promise<void> | undefined;
  private getRpcCallCount = 0;
  private readonly getRpcWaiters = new Set<() => void>();

  delayGetRpcUntil(promise: Promise<void>): void {
    this.getRpcDelay = promise;
  }

  waitForGetRpcCalls(count: number): Promise<void> {
    if (this.getRpcCallCount >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.getRpcCallCount < count) return;
        this.getRpcWaiters.delete(check);
        resolve();
      };
      this.getRpcWaiters.add(check);
    });
  }

  protected override async getRpc(): Promise<Record<string, unknown>> {
    this.getRpcCallCount += 1;
    for (const waiter of this.getRpcWaiters) waiter();
    if (this.getRpcDelay !== undefined) await this.getRpcDelay;
    return {
      prompt: async (input: unknown) => {
        this.promptCalls.push(input);
      },
      setModel: async (input: unknown) => {
        this.setModelCalls.push(input);
        return { model: 'captured-model' };
      },
      enterPlan: async (input: unknown) => {
        this.enterPlanCalls.push(input);
      },
      cancelPlan: async (input: unknown) => {
        this.cancelPlanCalls.push(input);
      },
      getPlan: async (input: unknown) => {
        this.getPlanCalls.push(input);
        return null;
      },
      clearPlan: async (input: unknown) => {
        this.clearPlanCalls.push(input);
      },
    };
  }
}

describe('Session.prompt input normalization', () => {
  it('passes multimodal prompt parts through to the core RPC client', async () => {
    const prompt = vi.fn(async () => {});
    const session = new Session({
      id: 'ses_multimodal_prompt',
      workDir: '/tmp/work',
      rpc: { prompt } as unknown as SDKRpcClientBase,
    });
    const input = [
      { type: 'text', text: 'describe these' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      { type: 'video_url', videoUrl: { url: 'ms://file-123', id: 'file-123' } },
    ] as const;

    await session.prompt(input);

    expect(prompt).toHaveBeenCalledWith({
      sessionId: 'ses_multimodal_prompt',
      input,
    });
  });

  it('starts btw and returns the forked agent id', async () => {
    const startBtw = vi.fn(async () => 'agent-btw');
    const session = new Session({
      id: 'ses_btw_start',
      workDir: '/tmp/work',
      rpc: { startBtw } as unknown as SDKRpcClientBase,
    });

    await expect(session.startBtw()).resolves.toBe('agent-btw');
    expect(startBtw).toHaveBeenCalledWith({
      sessionId: 'ses_btw_start',
    });
  });
});
