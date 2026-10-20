import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from '#/logging/logger';
import { limitAgentReplayByTurns, type AgentReplayRecord } from '#/replay';
import { foldAgentWireReplay } from '#/v2/resume-replay';
import { v2MetaToSessionMeta } from '#/v2/session-mapper';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-replay-'));
  tempDirs.push(dir);
  return dir;
}

function userTurn(text: string, time: number): AgentReplayRecord {
  return {
    type: 'message',
    time,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'user' },
    },
  };
}

function cronTurn(text: string, time: number): AgentReplayRecord {
  return {
    type: 'message',
    time,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: {
        kind: 'cron_job',
        jobId: 'job-1',
        cron: '*/15 * * * *',
        recurring: true,
        coalescedCount: 1,
        stale: false,
      },
    },
  };
}

function cronMissedTurn(text: string, time: number): AgentReplayRecord {
  return {
    type: 'message',
    time,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'cron_missed', count: 3 },
    },
  };
}

function injection(text: string, time: number): AgentReplayRecord {
  return {
    type: 'message',
    time,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'reminder' },
    },
  };
}

function assistant(text: string, time: number): AgentReplayRecord {
  return {
    type: 'message',
    time,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    },
  };
}

function replayBytes(records: readonly AgentReplayRecord[]): number {
  return records.reduce((sum, record) => sum + JSON.stringify(record).length, 0);
}

describe('limitAgentReplayByTurns', () => {
  it('keeps only the last N user turns', () => {
    const records: AgentReplayRecord[] = [];
    for (let turn = 0; turn < 20; turn++) {
      records.push(userTurn(`prompt ${turn}`, turn * 10));
      records.push(assistant(`answer ${turn}`, turn * 10 + 1));
    }
    const limited = limitAgentReplayByTurns(records, 5);
    expect(limited[0]).toMatchObject({ message: { origin: { kind: 'user' } } });
    expect(JSON.stringify(limited)).toContain('prompt 15');
    expect(JSON.stringify(limited)).not.toContain('prompt 14');
  });

  it('counts a steered skill input using the existing replay turn rule', () => {
    const origin = {
      kind: 'user' as const,
      inTurn: true as const,
      skillActivations: [
        { kind: 'skill_activation' as const, trigger: 'user-slash' as const, activationId: 'activation-review', skillName: 'review' },
      ],
    };
    const currentTurn = userTurn('current prompt', 2);
    const steered: AgentReplayRecord = {
      type: 'message',
      time: 3,
      message: {
        role: 'user',
        content: [{ type: 'text', text: '/skill:review src/app.ts' }],
        toolCalls: [],
        origin,
      },
    };
    const answer = assistant('review result', 4);
    const records = [userTurn('old prompt', 0), assistant('old answer', 1), currentTurn, steered, answer];

    expect(limitAgentReplayByTurns(records, 1)).toEqual([steered, answer]);
  });

  it('bounds replay volume when cron turns dominate the history', () => {
    const records: AgentReplayRecord[] = [];
    let time = 0;
    for (let turn = 0; turn < 30; turn++) {
      records.push(userTurn(`manual prompt ${turn}`, time++));
      records.push(assistant('manual answer', time++));
      for (let cron = 0; cron < 200; cron++) {
        records.push(cronTurn(`cron fire ${turn}:${cron} ${'x'.repeat(500)}`, time++));
        records.push(assistant(`cron report ${'y'.repeat(2000)}`, time++));
      }
    }
    const total = replayBytes(records);
    const limited = limitAgentReplayByTurns(records, 10);
    expect(limited.length).toBeLessThan(records.length / 10);
    expect(replayBytes(limited)).toBeLessThan(total / 10);
    expect(JSON.stringify(limited.at(-2))).toContain('cron fire 29:199');
  });

  it('treats cron_missed deliveries as turn boundaries', () => {
    const records: AgentReplayRecord[] = [];
    for (let turn = 0; turn < 20; turn++) {
      records.push(cronMissedTurn(`missed ${turn}`, turn * 2));
      records.push(assistant('report', turn * 2 + 1));
    }
    const limited = limitAgentReplayByTurns(records, 5);
    expect(JSON.stringify(limited)).toContain('missed 15');
    expect(JSON.stringify(limited)).not.toContain('missed 14');
  });

  it('does not let injection bursts shrink the window', () => {
    const records: AgentReplayRecord[] = [];
    for (let turn = 0; turn < 8; turn++) {
      records.push(userTurn(`prompt ${turn}`, turn * 100));
      records.push(assistant(`answer ${turn}`, turn * 100 + 1));
      for (let i = 0; i < 50; i++) {
        records.push(injection(`reminder ${turn}:${i}`, turn * 100 + 2 + i));
      }
    }
    const limited = limitAgentReplayByTurns(records, 5);
    expect(JSON.stringify(limited)).toContain('prompt 3');
    expect(JSON.stringify(limited)).not.toContain('prompt 2');
  });
});

describe('foldAgentWireReplay corruption handling', () => {
  it('keeps the records before a corrupted non-tail line and warns once', async () => {
    const dir = await makeTempDir();
    const wirePath = join(dir, 'wire.jsonl');
    await writeFile(
      wirePath,
      [
        '{"type":"permission.set_mode","mode":"auto","time":2}',
        '{"type":"permission.set_mode","mode":"aut',
        '{"type":"permission.set_mode","mode":"yolo","time":9}',
      ].join('\n') + '\n',
      'utf-8',
    );
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const folded = await foldAgentWireReplay(wirePath);

    expect(folded.replay).toEqual([{ type: 'permission_updated', mode: 'auto', time: 2 }]);
    expect(folded.toolStore).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('wire replay stopped at a corrupted line', {
      wirePath,
      line: 2,
    });
  });

  it('tolerates a truncated tail line without warning', async () => {
    const dir = await makeTempDir();
    const wirePath = join(dir, 'wire-tail.jsonl');
    await writeFile(
      wirePath,
      '{"type":"metadata","protocol_version":"1.5","created_at":1}\n' +
        '{"type":"permission.set_mode","mode":"auto","time":2}\n' +
        '{"type":"permission.set_mode","mode":"yo',
      'utf-8',
    );
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const folded = await foldAgentWireReplay(wirePath);

    expect(folded.replay).toEqual([{ type: 'permission_updated', mode: 'auto', time: 2 }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns an empty fold when the first line is the corrupted one', async () => {
    const dir = await makeTempDir();
    const wirePath = join(dir, 'wire-head.jsonl');
    await writeFile(
      wirePath,
      [
        '{not json',
        '{"type":"permission.set_mode","mode":"auto","time":2}',
      ].join('\n') + '\n',
      'utf-8',
    );
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    await expect(foldAgentWireReplay(wirePath)).resolves.toEqual({
      replay: [],
      toolStore: {},
      userTurnCount: 0,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('v2MetaToSessionMeta', () => {
  it('surfaces the swarm member marker persisted in v2 agent labels', () => {
    const meta = v2MetaToSessionMeta({
      id: 'ses_1',
      createdAt: 1000,
      updatedAt: 2000,
      archived: false,
      agents: {
        main: { type: 'main' },
        'agent-swarm': {
          type: 'sub',
          parentAgentId: 'main',
          labels: { parentAgentId: 'main', swarmItem: 'task one' },
        },
        'agent-plain': {
          type: 'sub',
          parentAgentId: 'main',
          labels: { parentAgentId: 'main' },
        },
        'agent-top-level': { type: 'sub', parentAgentId: 'main', swarmItem: 'top level' },
      },
    });

    expect(meta.agents['agent-swarm']?.swarmItem).toBe('task one');
    expect(meta.agents['agent-plain']?.swarmItem).toBeUndefined();
    expect(meta.agents['agent-top-level']?.swarmItem).toBe('top level');
  });

  it('surfaces the spawn profile persisted in v2 agent labels', () => {
    const meta = v2MetaToSessionMeta({
      id: 'ses_1',
      createdAt: 1000,
      updatedAt: 2000,
      archived: false,
      agents: {
        'agent-tower': {
          type: 'sub',
          parentAgentId: 'main',
          labels: { parentAgentId: 'main', profileName: 'tower-worker' },
        },
        'agent-coder': {
          type: 'sub',
          parentAgentId: 'main',
          labels: { parentAgentId: 'main', profileName: 'coder' },
        },
      },
    });

    expect(meta.agents['agent-tower']?.profileName).toBe('tower-worker');
    expect(meta.agents['agent-coder']?.profileName).toBe('coder');
  });

  it('surfaces the session-init marker persisted in v2 agent labels', () => {
    const meta = v2MetaToSessionMeta({
      id: 'ses_1',
      createdAt: 1000,
      updatedAt: 2000,
      archived: false,
      agents: {
        'agent-init': {
          type: 'sub',
          parentAgentId: 'main',
          labels: { profileName: 'coder', sessionInit: 'agents-md' },
        },
        'agent-plain': {
          type: 'sub',
          parentAgentId: 'main',
          labels: { profileName: 'coder' },
        },
      },
    });

    expect(meta.agents['agent-init']?.sessionInit).toBe('agents-md');
    expect(meta.agents['agent-plain']?.sessionInit).toBeUndefined();
  });
});
