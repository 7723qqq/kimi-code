/**
 * Agent + cron wiring smoke: verifies `new Agent(...)` constructs and
 * starts a CronManager, registers the three cron tools, and that
 * `KIMI_DISABLE_CRON=1` short-circuits `CronCreate`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CronCreateTool,
  type CronCreateInput,
} from '#/cron/tools/cron-create';
import { ICronService } from '#/cron';
import { IProfileService } from '#/profile';
import { IToolRegistry } from '#/toolRegistry';
import { createTestAgent, type TestAgentContext } from '../harness';

describe('Agent + Cron integration (P1.7)', () => {
  describe('default cron wiring', () => {
    let ctx: TestAgentContext;
    let cron: ICronService;
    let profile: IProfileService;

    beforeEach(() => {
      ctx = createTestAgent();
      cron = ctx.get(ICronService);
      profile = ctx.get(IProfileService);
      profile.update({ activeToolNames: ['CronCreate', 'CronList', 'CronDelete'] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
        vi.unstubAllEnvs();
      }
    });

    it('exposes agent.cron with its session store on construction', () => {
      expect(cron).toBeDefined();
      expect(cron.store).toBeDefined();
      expect(cron.store.list()).toEqual([]);
    });

    it('registers CronCreate / CronList / CronDelete in the tool manager', () => {
      const toolNames = ctx.toolsData().map((info) => info.name);
      expect(toolNames).toContain('CronCreate');
      expect(toolNames).toContain('CronList');
      expect(toolNames).toContain('CronDelete');

      // All three came in through the builtin barrel.
      for (const name of ['CronCreate', 'CronList', 'CronDelete'] as const) {
        const info = ctx.toolsData().find((i) => i.name === name);
        expect(info?.source).toBe('builtin');
        expect(info?.active).toBe(true);
      }
    });
  });

  describe('disabled cron config', () => {
    let ctx: TestAgentContext;
    let cron: ICronService;
    let profile: IProfileService;
    let tools: IToolRegistry;

    beforeEach(() => {
      vi.stubEnv('KIMI_DISABLE_CRON', '1');
      ctx = createTestAgent();
      cron = ctx.get(ICronService);
      profile = ctx.get(IProfileService);
      tools = ctx.get(IToolRegistry);
      profile.update({ activeToolNames: ['CronCreate'] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
        vi.unstubAllEnvs();
      }
    });

    it('short-circuits CronCreate with a disabled error', () => {
      const tool = tools.resolve('CronCreate') as CronCreateTool | undefined;
      expect(tool).toBeDefined();
      const args: CronCreateInput = {
        cron: '*/5 * * * *',
        prompt: 'x',
        recurring: true,
      };
      const result = tool!.resolveExecution(args);

      // resolveExecution returns a `ToolExecution` — when it errors
      // up-front the shape is `{ isError: true, output: string }` with no
      // `execute` callback (see CronCreate's killswitch branch).
      expect(result).toMatchObject({ isError: true });
      expect('output' in result ? result.output : '').toMatch(/disabled/i);
      expect('execute' in result ? typeof result.execute : 'no-execute').toBe(
        'no-execute',
      );

      // And no task slipped into the store.
      expect(cron.store.list()).toEqual([]);
    });
  });
});
