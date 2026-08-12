// apps/vis/server/test/routes/wire-sqlite.test.ts
//
// Stage-2 wire route coverage for the SQLite source: with
// KIMI_VIS_SOURCE=sqlite and KIMI_AGENT_HOME pinned to the fixture engine
// home, `/api/sessions/:id/wire` reconstructs the wire view from the
// `records` table, and `/api/sessions/:id/context` rebuilds the timeline
// from the `message.append` sequence when records exist.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildSqliteFixture } from '../fixtures/sqlite';
import { wireRoute } from '../../src/routes/wire';
import { contextRoute } from '../../src/routes/context';

interface ProjectedRecord {
  lineNo: number;
  data: { type: string; time?: number; [k: string]: unknown };
  raw: { type: string; [k: string]: unknown };
}

interface WireBody {
  sessionId: string;
  agentId: string;
  protocolVersion: string;
  metadata: {
    protocolVersion: string;
    createdAt: number;
    source?: string;
    recordTypes?: string[];
  };
  records: ProjectedRecord[];
  warnings: string[];
}

const ALL_RECORD_TYPES = [
  'turn.started',
  'message.append',
  'tool.call',
  'tool.result',
  'usage.updated',
  'goal.updated',
  'compaction.started',
  'compaction.completed',
];

describe('sqlite wire route (records → wire view)', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (cleanup) await cleanup();
    cleanup = null;
  });

  async function withEnv(): Promise<string> {
    const { home, cleanup: c } = await buildSqliteFixture();
    cleanup = c;
    vi.stubEnv('KIMI_VIS_SOURCE', 'sqlite');
    vi.stubEnv('KIMI_AGENT_HOME', home);
    return home;
  }

  it('projects records into wire entries with legacy-shape data', async () => {
    const home = await withEnv();
    const app = wireRoute(home);
    const res = await app.request('/sess-main/wire?agent=main');
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireBody;

    expect(body.sessionId).toBe('sess-main');
    expect(body.agentId).toBe('main');
    expect(body.protocolVersion).toBe('records');
    expect(body.metadata).toMatchObject({
      protocolVersion: 'records',
      source: 'sqlite',
      createdAt: Date.parse('2026-01-01T00:00:01Z'),
    });
    expect([...body.metadata.recordTypes!].toSorted()).toEqual([...ALL_RECORD_TYPES].toSorted());
    expect(body.warnings[0]).toContain('first record #1');
    expect(body.warnings[0]).toContain('10 total');

    expect(body.records).toHaveLength(10);
    // lineNo = record id; every entry carries `time` from created_at.
    body.records.forEach((r, i) => expect(r.lineNo).toBe(i + 1));
    expect(body.records[0]!.data.time).toBe(Date.parse('2026-01-01T00:00:01Z'));

    // Records without a legacy-wire counterpart keep the generic shape
    // (type = record_type) for the UI's unknown-type fallback renderer.
    expect(body.records[0]!.data).toMatchObject({ type: 'turn.started', turn_id: 'turn-1' });
    expect(body.records[0]!.raw).toMatchObject({ type: 'turn.started', turn_id: 'turn-1' });
    const compact = body.records.find((r) => r.data.type === 'compaction.completed');
    expect(compact!.data).toMatchObject({
      type: 'compaction.completed',
      trigger: 'auto',
      tokens_before: 100,
      tokens_after: 50,
      summary: 'earlier turns summarised',
    });
    const compactStart = body.records.find((r) => r.data.type === 'compaction.started');
    expect(compactStart!.data).toMatchObject({ trigger: 'auto', tokens_before: 100 });

    // message.append → context.append_message (snake_case → camelCase).
    const messages = body.records.filter((r) => r.data.type === 'context.append_message');
    expect(messages).toHaveLength(3);
    const userMsg = messages.find((m) => (m.data['message'] as { role: string }).role === 'user')!;
    expect(userMsg.lineNo).toBe(2);
    expect(userMsg.data['message']).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      toolCalls: [],
    });
    expect(userMsg.raw.type).toBe('message.append');
    const assistantMsg = messages.find(
      (m) => (m.data['message'] as { role: string }).role === 'assistant',
    )!;
    expect(assistantMsg.data['message']).toMatchObject({
      toolCalls: [
        { type: 'function', id: 'call_1', name: 'bash', arguments: '{"command":"echo hi"}' },
      ],
    });
    const toolMsg = messages.find((m) => (m.data['message'] as { role: string }).role === 'tool')!;
    expect(toolMsg.data['message']).toMatchObject({ toolCallId: 'call_1', isError: true });

    // tool.call / tool.result → context.append_loop_event so the wire UI's
    // pair indicator + hover protocol works unchanged.
    const call = body.records.find(
      (r) =>
        r.data.type === 'context.append_loop_event' &&
        (r.data['event'] as { type: string }).type === 'tool.call',
    )!;
    expect(call.data['event']).toMatchObject({
      type: 'tool.call',
      toolCallId: 'call_1',
      name: 'bash',
      args: { command: 'echo hi' },
      turnId: 'turn-1',
    });
    const result = body.records.find(
      (r) =>
        r.data.type === 'context.append_loop_event' &&
        (r.data['event'] as { type: string }).type === 'tool.result',
    )!;
    expect(result.data['event']).toMatchObject({
      type: 'tool.result',
      toolCallId: 'call_1',
      result: { output: 'done', isError: true },
    });

    // usage.updated → usage.record.
    const usage = body.records.find((r) => r.data.type === 'usage.record')!;
    expect(usage.data).toMatchObject({
      model: 'kimi-k2',
      usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
      usageScope: 'session',
    });

    // goal.updated → goal.update (engine GoalSnapshot is camelCase already).
    const goal = body.records.find((r) => r.data.type === 'goal.update')!;
    expect(goal.data).toMatchObject({ status: 'active', turnsUsed: 3, tokensUsed: 100 });
    expect(goal.raw.type).toBe('goal.updated');
  });

  it('serves empty records + warnings instead of 404 when a session has no records', async () => {
    const home = await withEnv();
    const app = wireRoute(home);
    const res = await app.request('/sess-older/wire?agent=main');
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireBody;
    expect(body.protocolVersion).toBe('records');
    expect(body.metadata).toMatchObject({ source: 'sqlite', recordTypes: [] });
    expect(body.records).toEqual([]);
    expect(body.warnings.join(' ')).toContain('no wire records');
  });

  it('serves empty records for a subagent id and 404 for an unknown agent', async () => {
    const home = await withEnv();
    const app = wireRoute(home);
    const sub = await app.request('/sess-main/wire?agent=task-abc12345');
    expect(sub.status).toBe(200);
    const subBody = (await sub.json()) as WireBody;
    expect(subBody.agentId).toBe('task-abc12345');
    expect(subBody.records).toEqual([]);

    const ghost = await app.request('/sess-main/wire?agent=ghost');
    expect(ghost.status).toBe(404);
    const ghostBody = (await ghost.json()) as { code: string };
    expect(ghostBody.code).toBe('NOT_FOUND');
  });

  it('rebuilds the context timeline from message.append records', async () => {
    const home = await withEnv();
    const app = contextRoute(home);
    const res = await app.request('/sess-main/context?agent=main&history=full');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{
        lineNo: number;
        source: string;
        message: { role: string; content: Array<{ text?: string }>; toolCallId?: string; isError?: boolean };
      }>;
    };
    // Rebuilt from the three message.append rows (ids 2/3/6) — the FULL
    // append history, not the state_json snapshot.
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]).toMatchObject({
      lineNo: 2,
      source: 'append_message',
      message: { role: 'user', content: [{ text: 'hi' }] },
    });
    expect(body.messages[1]!.message.role).toBe('assistant');
    expect(body.messages[2]).toMatchObject({
      lineNo: 6,
      message: { role: 'tool', toolCallId: 'call_1', isError: true },
    });
  });

  it('falls back to the snapshot projection when a session has no records', async () => {
    const home = await withEnv();
    const app = contextRoute(home);
    const res = await app.request('/sess-older/context?agent=main');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[] };
    // sess-older has no agent_state context and no records → empty list.
    expect(body.messages).toEqual([]);
  });
});
