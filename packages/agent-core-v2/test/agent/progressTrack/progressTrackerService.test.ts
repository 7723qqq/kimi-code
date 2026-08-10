/**
 * EBM reminder injection tests — the service side of progress tracking:
 * three unverified mutations in a turn trip the Evidence-Before-More-Mutation
 * reminder into the model-visible context.
 */

import { describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { ExecutableTool } from '#/tool/toolContract';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ToolAccesses } from '#/tool/toolContract';
import { EBM_REMINDER_VARIANT } from '#/agent/progressTrack/progressTrackerService';
import { permissionModeServices, testAgent } from '../../harness';

const mutateTool: ExecutableTool<{ path: string }> = {
  name: 'Mutate',
  description: 'Write a short value to a file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  resolveExecution: (input) => ({
    approvalRule: 'Mutate',
    accesses: ToolAccesses.writeFile(input.path),
    execute: async () => ({ output: 'mutated' }),
  }),
};

/** A command-carrying tool whose args.command feeds the verification classifier. */
const verifyTool: ExecutableTool<{ command: string }> = {
  name: 'Verify',
  description: 'Run a verification command.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  resolveExecution: (input) => ({
    approvalRule: 'Verify',
    execute: async () => ({ output: 'verified' }),
  }),
};

function verifyCall(command: string) {
  return {
    type: 'function' as const,
    id: 'call_verify_1',
    name: 'Verify',
    arguments: JSON.stringify({ command }),
  };
}

function mutateCall(n: number) {
  return {
    type: 'function' as const,
    id: `call_mutate_${n}`,
    name: 'Mutate',
    arguments: JSON.stringify({ path: `/tmp/mutate-${n}.txt` }),
  };
}

function contextText(ctx: ReturnType<typeof testAgent>): string {
  return ctx.context
    .get()
    .map((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''))
    .join('\n');
}

describe('progress-track EBM reminder', () => {
  it('injects the reminder after three unverified mutations in one turn', async () => {
    const ctx = testAgent(permissionModeServices('yolo'));
    ctx.get(IAgentToolRegistryService).register(mutateTool);
    ctx.get(IAgentProfileService).update({ activeToolNames: ['Mutate'] });

    ctx.mockNextResponse({ type: 'text', text: 'mutating' }, mutateCall(1));
    ctx.mockNextResponse({ type: 'text', text: 'mutating' }, mutateCall(2));
    ctx.mockNextResponse({ type: 'text', text: 'mutating' }, mutateCall(3));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'mutate three files' }] });
    await ctx.untilTurnEnd();

    const text = contextText(ctx);
    expect(text).toContain('Run a verification command');
    // The reminder is a user-role injection with the EBM variant.
    const memory = ctx.get(IAgentContextMemoryService);
    const reminders = memory
      .get()
      .filter((m) => m.origin?.kind === 'injection' && m.origin.variant === EBM_REMINDER_VARIANT);
    expect(reminders.length).toBe(1);
  });

  it('does not inject the reminder when a verification command clears the debt', async () => {
    const ctx = testAgent(permissionModeServices('yolo'));
    ctx.get(IAgentToolRegistryService).register(mutateTool);
    ctx.get(IAgentToolRegistryService).register(verifyTool);
    ctx.get(IAgentProfileService).update({ activeToolNames: ['Mutate', 'Verify'] });

    // Two mutations build debt, the verification clears it, then two more
    // mutations stay below the threshold — the reminder must not fire. If the
    // verification had NOT cleared the debt, the final mutation would leave
    // blindMutations=4 and trip the reminder.
    ctx.mockNextResponse({ type: 'text', text: 'mutating' }, mutateCall(1));
    ctx.mockNextResponse({ type: 'text', text: 'mutating' }, mutateCall(2));
    ctx.mockNextResponse({ type: 'text', text: 'verifying' }, verifyCall('npm test'));
    ctx.mockNextResponse({ type: 'text', text: 'mutating' }, mutateCall(3));
    ctx.mockNextResponse({ type: 'text', text: 'mutating' }, mutateCall(4));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'mutate, verify, mutate' }] });
    await ctx.untilTurnEnd();

    expect(contextText(ctx)).not.toContain('Run a verification command');
  });
});
