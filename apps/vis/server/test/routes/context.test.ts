import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCompactionContinuationText } from '@moonshot-ai/agent-core-v2/agent/contextMemory/compactionHandoff';
import { buildSessionFixture } from '../fixtures/build';
import { contextRoute } from '../../src/routes/context';

describe('context route', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('echoes the new projection fields (contextTokens, goal, swarm)', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;

    const app = contextRoute(home);
    const res = await app.request('/session_fixture/context?agent=main');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // The route must pass these projection fields straight through (it used to
    // cherry-pick only messages/usage/config/permission/planMode).
    expect(body).toHaveProperty('contextTokens');
    expect(body).toHaveProperty('goal');
    expect(body).toHaveProperty('swarm');

    // The sample fixture's only step.end carries usage 10+5 → contextTokens=15,
    // and has no goal / swarm records.
    expect(body['contextTokens']).toBe(15);
    expect(body['goal']).toBeNull();
    expect(body['swarm']).toEqual({ active: false });
  });

  it('still echoes the existing fields', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;

    const app = contextRoute(home);
    const res = await app.request('/session_fixture/context?agent=main');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body['sessionId']).toBe('session_fixture');
    expect(body['agentId']).toBe('main');
    expect(body).toHaveProperty('messages');
    expect(body).toHaveProperty('usage');
    expect(body).toHaveProperty('config');
    expect(body).toHaveProperty('permission');
    expect(body).toHaveProperty('planMode');
  });

  it('returns 404 for missing session', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const app = contextRoute(home);
    const res = await app.request('/no-such-session/context?agent=main');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns 400 for invalid agent id', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const app = contextRoute(home);
    const res = await app.request('/session_fixture/context?agent=../escape');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('?history=full returns the pre-compaction messages (full reconstructed history)', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-compaction');
    cleanup = c;
    const app = contextRoute(home);

    // Default (model view): the real user prompt before compaction is KEPT, the
    // assistant reply is dropped, then the summary, then the post-compaction tail.
    const modelRes = await app.request('/session_fixture/context?agent=main');
    expect(modelRes.status).toBe(200);
    const modelBody = (await modelRes.json()) as {
      messages: { source: string; message: { content: { type: string; text?: string }[] } }[];
    };
    expect(modelBody.messages.map((m) => m.source)).toEqual([
      'append_message', 'compaction_summary', 'append_message', 'append_message',
    ]);
    expect(modelBody.messages[0]!.message.content[0]).toMatchObject({ text: 'before compaction' });
    expect(modelBody.messages[2]!.message.content[0]).toMatchObject({ text: buildCompactionContinuationText() });
    expect(modelBody.messages[3]!.message.content[0]).toMatchObject({ text: 'after compaction' });

    // Full history: every pre-compaction message (user prompt + assistant reply)
    // is KEPT, then the summary marker, then the post-compaction tail.
    const fullRes = await app.request('/session_fixture/context?agent=main&history=full');
    expect(fullRes.status).toBe(200);
    const fullBody = (await fullRes.json()) as {
      messages: { source: string; message: { content: { type: string; text?: string }[] } }[];
    };
    expect(fullBody.messages.map((m) => m.source)).toEqual([
      'append_message', 'append_message', 'compaction_summary', 'append_message',
    ]);
    expect(fullBody.messages[0]!.message.content[0]).toMatchObject({ text: 'before compaction' });
    expect(fullBody.messages[1]!.message.content[0]).toMatchObject({ text: 'assistant reply' });
    expect(fullBody.messages[3]!.message.content[0]).toMatchObject({ text: 'after compaction' });
  });

  // Audit a37/F3 + a37/F4 — a single malformed record used to throw out of
  // `projectContext`, and the catch-all in this route turned that into a
  // permanent 500 for the whole session. The records must be skipped, the
  // route must stay 200, and the caveats must reach the UI's warnings channel.
  it('stays 200 on malformed usage / replace_tool_result records and reports them', async () => {
    const home = await mkdtemp(join(tmpdir(), 'vis-ctx-malformed-'));
    cleanup = () => rm(home, { recursive: true, force: true });
    const sessionDir = join(home, 'sessions', 'wd_test_malformed', 'session_fixture');
    const agentsDir = join(sessionDir, 'agents', 'main');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'wire.jsonl'),
      [
        JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: 1 }),
        JSON.stringify({
          type: 'context.append_message',
          message: {
            role: 'tool',
            toolCallId: 'call-1',
            content: [{ type: 'text', text: 'predicted' }],
          },
          time: 2,
        }),
        JSON.stringify({ type: 'context.replace_tool_result', toolCallId: 'call-1', time: 3 }),
        JSON.stringify({
          type: 'usage.record',
          model: 'm',
          usageScope: 'x',
          usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
          time: 4,
        }),
        JSON.stringify({
          type: 'usage.record',
          model: 'm',
          usage: { inputOther: 5, output: 6, inputCacheRead: 0, inputCacheCreation: 0 },
          time: 5,
        }),
      ].join('\n') + '\n',
    );
    await writeFile(
      join(home, 'session_index.jsonl'),
      JSON.stringify({
        sessionId: 'session_fixture',
        sessionDir,
        workDir: '/tmp/work',
      }) + '\n',
    );

    const app = contextRoute(home);
    const res = await app.request('/session_fixture/context?agent=main');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: { message: { content: { type: string; text?: string }[] } }[];
      usage: { byScope: { session: Record<string, number>; turn: Record<string, number> } };
      warnings: string[];
    };

    // The malformed replace kept the prediction; the unknown scope folded into
    // session (1+5 / 2+6) and the second, well-formed record still counted.
    expect(body.messages[0]!.message.content).toEqual([{ type: 'text', text: 'predicted' }]);
    expect(body.usage.byScope.session).toEqual({
      inputOther: 6, output: 8, inputCacheRead: 3, inputCacheCreation: 4,
    });
    expect(body.usage.byScope.turn).toEqual({
      inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0,
    });
    expect(body.warnings.some((w) => /replace_tool_result skipped/.test(w))).toBe(true);
  });
});
