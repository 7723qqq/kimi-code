// apps/vis/server/test/routes/sqlite.test.ts
//
// Route-level coverage of the SQLite source: with KIMI_VIS_SOURCE=sqlite and
// KIMI_AGENT_HOME pinned to a fixture engine home, the /api/sessions routes
// serve engine-db data. KIMI_AGENT_HOME is process-global, so every test in
// this file shares the same pinned fixture home.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildSqliteFixture } from '../fixtures/sqlite';
import { sessionsRoute } from '../../src/routes/sessions';
import { sessionDetailRoute } from '../../src/routes/session-detail';
import { contextRoute } from '../../src/routes/context';
import { tasksRoute } from '../../src/routes/tasks';
import { cronRoute } from '../../src/routes/cron';
import { subagentsRoute } from '../../src/routes/subagents';

describe('sqlite routes (KIMI_VIS_SOURCE=sqlite)', () => {
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

  it('lists SQLite sessions and rejects deletion (read-only source)', async () => {
    const home = await withEnv();
    const app = sessionsRoute(home);
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
    expect(body.sessions.map((s) => s.sessionId)).toEqual(['sess-main', 'sess-older']);

    const del = await app.request('/sess-main', { method: 'DELETE' });
    expect(del.status).toBe(400);
    const delBody = (await del.json()) as { code: string };
    expect(delBody.code).toBe('BAD_REQUEST');

    const reveal = await app.request('/sess-main/reveal', { method: 'POST' });
    expect(reveal.status).toBe(400);
  });

  it('serves a session detail marked as sqlite source', async () => {
    const home = await withEnv();
    const app = sessionDetailRoute(home);
    const res = await app.request('/sess-main');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source?: string; sessionId: string; workDir: string };
    expect(body.sessionId).toBe('sess-main');
    expect(body.source).toBe('sqlite');
    expect(body.workDir).toBe('C:/work');
    const missing = await app.request('/nope');
    expect(missing.status).toBe(404);
  });

  it('projects context for main and subagent agents', async () => {
    const home = await withEnv();
    const app = contextRoute(home);
    const res = await app.request('/sess-main/context?agent=main');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentId: string; messages: Array<{ lineNo: number }> };
    expect(body.agentId).toBe('main');
    // sess-main has engine records: the timeline is rebuilt from its
    // `message.append` rows (ids 2/3/6), not the state_json snapshot.
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]!.lineNo).toBe(2);

    const sub = await app.request('/sess-main/context?agent=task-abc12345');
    expect(sub.status).toBe(200);
    const subBody = (await sub.json()) as { messages: Array<{ message: { content: Array<{ text: string }> } }> };
    expect(subBody.messages).toHaveLength(1);
    expect(subBody.messages[0]!.message.content[0]!.text).toBe('sub prompt');

    const missing = await app.request('/sess-main/context?agent=ghost');
    expect(missing.status).toBe(404);
  });

  it('lists tasks and pages output windows from agent_tasks.db', async () => {
    const home = await withEnv();
    const app = tasksRoute(home);
    const res = await app.request('/sess-main/tasks');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; tasks: Array<{ task: { taskId: string } }> };
    expect(body.sessionId).toBe('sess-main');
    expect(body.tasks.map((t) => t.task.taskId)).toEqual(['bash-bbq1814n', 'question-cdz1814n', 'bash-abc12345']);

    const out = await app.request('/sess-main/tasks/bash-abc12345/output?offset=0&limit=6');
    expect(out.status).toBe(200);
    const outBody = (await out.json()) as { content: string; nextOffset: number; size: number; eof: boolean };
    expect(outBody.content).toBe('hello ');
    expect(outBody.nextOffset).toBe(6);
    expect(outBody.size).toBe(11);
    expect(outBody.eof).toBe(false);
  });

  it('lists cron tasks from the shared task database', async () => {
    const home = await withEnv();
    const app = cronRoute(home);
    const res = await app.request('/sess-main/cron');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cron: Array<{ id: string; cron: string }> };
    expect(body.cron).toHaveLength(2);
    expect(body.cron[0]).toMatchObject({ id: 'cron-1', cron: '0 9 * * *' });
  });

  it('flattens the agent tree to root + subagents', async () => {
    const home = await withEnv();
    const app = subagentsRoute(home);
    const res = await app.request('/sess-main/agents');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tree: Array<{ agentId: string; children: unknown[] }> };
    expect(body.tree.map((n) => n.agentId)).toEqual(['main', 'task-abc12345', 'task-corrupt0001']);
    for (const node of body.tree) {
      expect(node.children).toEqual([]);
    }
  });
});
