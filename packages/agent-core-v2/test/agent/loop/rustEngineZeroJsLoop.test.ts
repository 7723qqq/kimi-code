import { afterEach, describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IEngineOverrideService, type TurnEngine } from '#/agent/loop/engineOverride';
import { emptyUsage } from '#/kosong/contract/usage';

import {
  appService,
  createTestAgent,
  permissionModeServices,
  type TestAgentContext,
} from '../../harness';
import { makeEchoTool, registerTool } from './helpers';

/**
 * Coverage vehicle for the G-5 machine proof: every test here drives a
 * whole turn through a stub `TurnEngine`, so the JS step loop inside
 * `loopService.ts` must never execute. The companion script
 * `scripts/check-engine-zero-js-loop.mjs` runs this file under v8
 * coverage and asserts exactly that — do not add a JS-path test here,
 * it would pollute the coverage the script asserts on.
 */
describe('rust engine zero JS loop', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    if (ctx !== undefined) {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  it('drives a single-step turn entirely through the engine', async () => {
    let engineCalls = 0;
    const engine: TurnEngine = async (input) => {
      engineCalls += 1;
      await input.dispatchEvent({
        type: 'step.begin',
        uuid: 'step-1',
        turnId: String(input.turnId),
        step: 1,
      });
      await input.dispatchEvent({
        type: 'content.part',
        uuid: 'part-1',
        turnId: String(input.turnId),
        step: 1,
        stepUuid: 'step-1',
        part: { type: 'text', text: 'engine-only turn' },
      });
      await input.dispatchEvent({
        type: 'step.end',
        uuid: 'step-1',
        turnId: String(input.turnId),
        step: 1,
        usage: emptyUsage(),
      });
      return {
        stopReason: 'completed',
        steps: 1,
        usage: { inputOther: 3, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
      };
    };

    ctx = createTestAgent(appService(IEngineOverrideService, { getEngine: () => engine }));
    void ctx.restoreRuntimes();
    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await end;

    expect(engineCalls).toBe(1);
    const context = ctx.get(IAgentContextMemoryService).get();
    expect(
      context.some((m) =>
        m.content.some((p) => p.type === 'text' && p.text.includes('engine-only turn')),
      ),
    ).toBe(true);
  });

  it('drives a multi-step turn with a tool round-trip through the engine', async () => {
    const tool = makeEchoTool();
    const engine: TurnEngine = async (input) => {
      for (let step = 1; step <= 2; step += 1) {
        await input.dispatchEvent({
          type: 'step.begin',
          uuid: `step-${step}`,
          turnId: String(input.turnId),
          step,
        });
        if (step === 1) {
          await input.dispatchEvent({
            type: 'tool.call',
            uuid: 'tc-1',
            turnId: String(input.turnId),
            step,
            stepUuid: `step-${step}`,
            toolCallId: 'call-1',
            name: 'echo',
            args: { text: 'zero-js' },
          });
          const outcome = await input.executeTool(
            { type: 'function', id: 'call-1', name: 'echo', arguments: '{"text":"zero-js"}' },
            { signal: input.signal, turnId: input.turnId },
          );
          await input.dispatchEvent({
            type: 'tool.result',
            parentUuid: 'tc-1',
            toolCallId: 'call-1',
            result: { output: outcome.output },
          });
        }
        await input.dispatchEvent({
          type: 'content.part',
          uuid: `part-${step}`,
          turnId: String(input.turnId),
          step,
          stepUuid: `step-${step}`,
          part: { type: 'text', text: `engine step ${step}` },
        });
        await input.dispatchEvent({
          type: 'step.end',
          uuid: `step-${step}`,
          turnId: String(input.turnId),
          step,
          usage: emptyUsage(),
        });
      }
      return { stopReason: 'completed', steps: 2, usage: emptyUsage() };
    };

    ctx = createTestAgent(
      appService(IEngineOverrideService, { getEngine: () => engine }),
      permissionModeServices('yolo'),
    );
    registerTool(ctx, tool);
    void ctx.restoreRuntimes();
    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'go' }] });
    await end;

    expect(tool.calls).toHaveLength(1);
    expect(tool.calls[0]?.args).toEqual({ text: 'zero-js' });
  });
});