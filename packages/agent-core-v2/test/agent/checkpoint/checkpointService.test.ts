/**
 * File checkpoint tests: pre-write capture, undo restore, conflict
 * detection (ported from Reasonix's checkpoint contract, trimmed).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IEventBus } from '#/app/event/eventBus';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { ExecutableTool } from '#/tool/toolContract';
import { ToolAccesses } from '#/tool/toolContract';
import { permissionModeServices, testAgent } from '../../harness';

let workDir: string;

const writeTool: ExecutableTool<{ path: string; content: string }> = {
  name: 'FileWrite',
  description: 'Write content to a file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  resolveExecution: (input) => ({
    approvalRule: 'FileWrite',
    accesses: ToolAccesses.writeFile(join(workDir, input.path)),
    execute: async () => {
      await writeFile(join(workDir, input.path), input.content, 'utf8');
      return { output: 'written' };
    },
  }),
};

function writeCall(path: string, content: string) {
  return {
    type: 'function' as const,
    id: 'call_write_1',
    name: 'FileWrite',
    arguments: JSON.stringify({ path, content }),
  };
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'kimi-checkpoint-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('file checkpoints', () => {
  it('captures preimages and restores them on undo', async () => {
    await writeFile(join(workDir, 'a.txt'), 'original', 'utf8');
    const ctx = testAgent(permissionModeServices('yolo'));
    ctx.get(IAgentToolRegistryService).register(writeTool);
    ctx.get(IAgentProfileService).update({ activeToolNames: ['FileWrite'] });

    ctx.mockNextResponse({ type: 'text', text: 'writing' }, writeCall('a.txt', 'modified'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'modify a.txt' }] });
    await ctx.untilTurnEnd();
    expect(await readFile(join(workDir, 'a.txt'), 'utf8')).toBe('modified');

    // Undo the turn: the file must come back to its preimage.
    await ctx.rpc.undoHistory({ count: 1 });
    expect(await readFile(join(workDir, 'a.txt'), 'utf8')).toBe('original');
  });

  it('restores deleted files and reports conflicts for manual edits', async () => {
    await writeFile(join(workDir, 'b.txt'), 'original', 'utf8');
    const ctx = testAgent(permissionModeServices('yolo'));
    ctx.get(IAgentToolRegistryService).register(writeTool);
    ctx.get(IAgentProfileService).update({ activeToolNames: ['FileWrite'] });

    ctx.mockNextResponse({ type: 'text', text: 'writing' }, writeCall('b.txt', 'modified'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'modify b.txt' }] });
    await ctx.untilTurnEnd();

    // Simulate a manual edit after the turn: restore must not clobber it.
    await writeFile(join(workDir, 'b.txt'), 'manual edit', 'utf8');
    const restored = new Promise<unknown>((resolve) => {
      const bus = ctx.get(IEventBus);
      const d = bus.subscribe('checkpoint.restored', (e) => {
        d.dispose();
        resolve(e);
      });
    });
    await ctx.rpc.undoHistory({ count: 1 });
    const event = (await restored) as { conflicts: Array<{ path: string; reason: string }> };
    expect(await readFile(join(workDir, 'b.txt'), 'utf8')).toBe('manual edit');
    expect(event.conflicts.some((c) => c.path.endsWith('b.txt') && c.reason === 'manual_edit')).toBe(true);
  });

  it('creates files on restore when the preimage did not exist', async () => {
    const ctx = testAgent(permissionModeServices('yolo'));
    ctx.get(IAgentToolRegistryService).register(writeTool);
    ctx.get(IAgentProfileService).update({ activeToolNames: ['FileWrite'] });

    // The file did not exist before the write; after undo it must be gone.
    ctx.mockNextResponse({ type: 'text', text: 'writing' }, writeCall('new.txt', 'created'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'create new.txt' }] });
    await ctx.untilTurnEnd();
    expect(await readFile(join(workDir, 'new.txt'), 'utf8')).toBe('created');

    await ctx.rpc.undoHistory({ count: 1 });
    await expect(readFile(join(workDir, 'new.txt'), 'utf8')).rejects.toThrow();
  });
});
