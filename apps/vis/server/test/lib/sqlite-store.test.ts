// apps/vis/server/test/lib/sqlite-store.test.ts
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { buildSqliteFixture } from '../fixtures/sqlite';
import {
  hasSqliteData,
  listSqliteCron,
  listSqliteSessions,
  listSqliteTasks,
  projectSqliteContext,
  readSqliteSessionDetail,
  readSqliteTaskOutput,
  resolveAgentHome,
} from '../../src/lib/sqlite-store';

describe('sqlite-store', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it('lists main sessions newest-first, filtering subagent rows', async () => {
    const { home, cleanup: c } = await buildSqliteFixture();
    cleanup = c;
    const sessions = listSqliteSessions(home);
    expect(sessions.map((s) => s.sessionId)).toEqual(['sess-main', 'sess-older']);
    const main = sessions[0]!;
    expect(main.title).toBe('hello sqlite');
    expect(main.workDir).toBe('C:/work');
    expect(main.createdAt).toBe(Date.parse('2026-01-01T00:00:00.000000Z'));
    expect(main.updatedAt).toBe(Date.parse('2026-01-02T00:00:00.000000Z'));
    expect(main.sessionDir).toBe('');
    expect(main.health).toBe('ok');
    expect(main.lastPrompt).toBeNull();
    expect(main.mainAgentExists).toBe(false);
    // No title on the record → null, not ''.
    expect(sessions[1]!.title).toBeNull();
  });

  it('hasSqliteData reflects whether sessions.db is readable', async () => {
    const { home, cleanup: c } = await buildSqliteFixture();
    cleanup = c;
    expect(hasSqliteData(home)).toBe(true);
    expect(hasSqliteData(join(home, 'nope'))).toBe(false);
  });

  it('reads a main session detail with a flat main + subagent inventory', async () => {
    const { home, cleanup: c } = await buildSqliteFixture();
    cleanup = c;
    const detail = readSqliteSessionDetail(home, 'sess-main');
    expect(detail).not.toBeNull();
    expect(detail!.source).toBe('sqlite');
    expect(detail!.workDir).toBe('C:/work');
    expect(detail!.sessionDir).toBe('');
    expect(detail!.agents.map((a) => a.agentId)).toEqual(['main', 'task-abc12345', 'task-corrupt0001']);
    const main = detail!.agents[0]!;
    expect(main.type).toBe('main');
    expect(main.parentAgentId).toBeNull();
    expect(main.wireExists).toBe(false);
    expect(main.homedir).toBe('');
    const sub = detail!.agents[1]!;
    expect(sub.type).toBe('independent');
    expect(sub.agentId).toBe('task-abc12345');
  });

  it('reads a subagent row as its own session', async () => {
    const { home, cleanup: c } = await buildSqliteFixture();
    cleanup = c;
    const detail = readSqliteSessionDetail(home, 'task-abc12345');
    expect(detail).not.toBeNull();
    expect(detail!.workDir).toBe('');
    expect(detail!.agents).toHaveLength(1);
    expect(detail!.agents[0]!.agentId).toBe('task-abc12345');
    // Unreadable state_json rows still resolve (state null is tolerable).
    expect(readSqliteSessionDetail(home, 'task-corrupt0001')!.state).toBeNull();
  });

  it('returns null for an unknown session id', async () => {
    const { home, cleanup: c } = await buildSqliteFixture();
    cleanup = c;
    expect(readSqliteSessionDetail(home, 'nope')).toBeNull();
  });

  it('projects a main-session context (snake_case → camelCase)', async () => {
    const { home, cleanup: c } = await buildSqliteFixture();
    cleanup = c;
    const detail = readSqliteSessionDetail(home, 'sess-main')!;
    const proj = projectSqliteContext(detail.state);
    expect(proj.messages).toHaveLength(3);
    expect(proj.messages.map((m) => m.source)).toEqual(['append_message', 'append_message', 'append_message']);
    expect(proj.messages[0]!.lineNo).toBe(1);
    expect(proj.messages[0]!.message.role).toBe('user');
    expect(proj.messages[0]!.message.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(proj.messages[0]!.message.origin).toEqual({ kind: 'user' });
    const assistant = proj.messages[1]!.message;
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls[0]).toEqual({
      type: 'function',
      id: 'call_1',
      name: 'bash',
      arguments: '{"command":"echo hi"}',
    });
    const tool = proj.messages[2]!.message;
    expect(tool.role).toBe('tool');
    expect(tool.toolCallId).toBe('call_1');
    expect(tool.isError).toBe(true);
    expect(proj.contextTokens).toBe(42);
    expect(proj.planMode).toEqual({ active: true, id: 'plan-1' });
    expect(proj.goal).toEqual({
      goalId: 'g-1',
      objective: 'fix the build',
      completionCriterion: 'tests green',
      status: 'active',
      tokensUsed: 100,
      turnsUsed: 3,
      wallClockMs: 5000,
    });
    expect(proj.config.cwd).toBe('C:/work');
    expect(proj.permission).toEqual({ mode: null });
    expect(proj.swarm).toEqual({ active: false });
    expect(proj.usage.byScope.session).toEqual({ inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 });
  });

  it('projects a subagent context from the durable-state top level', async () => {
    const { home, cleanup: c } = await buildSqliteFixture();
    cleanup = c;
    const detail = readSqliteSessionDetail(home, 'task-abc12345')!;
    const proj = projectSqliteContext(detail.state);
    expect(proj.messages).toHaveLength(1);
    expect(proj.messages[0]!.message.content).toEqual([{ type: 'text', text: 'sub prompt' }]);
    expect(proj.contextTokens).toBe(7);
    expect(proj.planMode).toEqual({ active: false });
    expect(proj.goal).toBeNull();
  });

  it('lists background tasks from both tables, newest first, with output sizes', async () => {
    const { home, cleanup: c } = await buildSqliteFixture();
    cleanup = c;
    const entries = listSqliteTasks(home);
    // bash-bbq1814n (bg, started 1785743400000) > question-cdz1814n (bg, 1785743399616) > bash-abc12345 (flat, 1700000000000)
    expect(entries.map((e) => e.task.taskId)).toEqual(['bash-bbq1814n', 'question-cdz1814n', 'bash-abc12345']);
    const flat = entries.find((e) => e.task.taskId === 'bash-abc12345')!;
    expect(flat.task).toMatchObject({
      taskId: 'bash-abc12345',
      description: 'run tests',
      status: 'completed',
      kind: 'process',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_000_100,
      detached: false,
    });
    expect(flat.task.command).toBeUndefined(); // flat TaskInfoBase has no process fields
    expect(flat.agentId).toBe('main');
    expect(flat.outputSizeBytes).toBe(11);
    expect(flat.outputExists).toBe(true);
    const proc = entries.find((e) => e.task.taskId === 'bash-bbq1814n')!;
    expect(proc.task).toMatchObject({
      kind: 'process',
      command: 'cargo run',
      pid: 4242,
      exitCode: 1,
      status: 'failed',
      detached: true,
      startedAt: 1_785_743_400_000,
    });
    expect(proc.agentId).toBe('main');
    expect(proc.outputSizeBytes).toBe(Buffer.byteLength('compiling…', 'utf8'));
    const question = entries.find((e) => e.task.taskId === 'question-cdz1814n')!;
    expect(question.task.kind).toBe('question');
    expect(question.outputSizeBytes).toBe(0);
    expect(question.outputExists).toBe(false);
  });

  it('reads task output as byte windows across chunks', async () => {
    const { home, cleanup: c } = await buildSqliteFixture();
    cleanup = c;
    const w = readSqliteTaskOutput(home, 'bash-abc12345', 0, 6);
    expect(w.content).toBe('hello ');
    expect(w.offset).toBe(0);
    expect(w.nextOffset).toBe(6);
    expect(w.size).toBe(11);
    expect(w.eof).toBe(false);
    const rest = readSqliteTaskOutput(home, 'bash-abc12345', w.nextOffset, 1024);
    expect(rest.content).toBe('world');
    expect(rest.eof).toBe(true);
    // Past EOF → empty window at the end.
    const past = readSqliteTaskOutput(home, 'bash-abc12345', 100, 10);
    expect(past.content).toBe('');
    expect(past.eof).toBe(true);
    expect(past.size).toBe(11);
    // Unknown task → empty.
    const unknown = readSqliteTaskOutput(home, 'nope-00000000', 0, 10);
    expect(unknown.size).toBe(0);
    expect(unknown.eof).toBe(true);
  });

  it('lists cron tasks with decimal-ms timestamp conversion', async () => {
    const { home, cleanup: c } = await buildSqliteFixture();
    cleanup = c;
    const cron = listSqliteCron(home);
    expect(cron).toHaveLength(2);
    expect(cron[0]).toEqual({
      id: 'cron-1',
      cron: '0 9 * * *',
      prompt: 'morning report',
      createdAt: 1_700_000_000_000,
      recurring: true,
      lastFiredAt: 1_700_000_100_000,
    });
    expect(cron[1]).toEqual({
      id: 'cron-2',
      cron: '0 0 * * *',
      prompt: 'daily backup',
      createdAt: 1_700_000_000_001,
      recurring: false,
    });
  });

  it('resolveAgentHome prefers KIMI_AGENT_HOME, then the explicit arg, then the default', () => {
    const prev = process.env['KIMI_AGENT_HOME'];
    try {
      process.env['KIMI_AGENT_HOME'] = '/engine/home';
      expect(resolveAgentHome()).toBe('/engine/home');
      expect(resolveAgentHome('/explicit')).toBe('/explicit');
      process.env['KIMI_AGENT_HOME'] = '';
      expect(resolveAgentHome('/explicit')).toBe('/explicit');
      expect(resolveAgentHome().endsWith(join('', '.kimi-code', 'agent'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['KIMI_AGENT_HOME'];
      else process.env['KIMI_AGENT_HOME'] = prev;
    }
  });
});
