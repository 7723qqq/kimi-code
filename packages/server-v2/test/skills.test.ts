/**
 * `/api/v1` skills routes — server-v2 port of `packages/server/test/skills.e2e.test.ts`.
 *
 * Covers the wire contract of the two endpoints:
 *   - GET  /api/v1/sessions/{sid}/skills                  → envelope shape + skills[]
 *   - GET  on an unknown session                          → 40401 "does not exist"
 *   - GET  on a persisted-but-not-activated session        → 40401 "not activated ..."
 *   - POST /api/v1/sessions/{sid}/skills/{name}:activate   → {activated:true, skill_name}
 *   - POST :activate an unknown skill                      → 40415
 *   - POST bare `{name}` / bogus action                    → 40001
 *
 * Skills are resolved from the per-session `ISessionSkillCatalog` (list) and the main
 * agent's `IAgentSkillService` (activate). A session created through
 * `POST /sessions` is already activated (live), so listing/activation work
 * immediately; the "not activated" branch is exercised by archiving the session
 * (it stays in the index but leaves the live map).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  ISessionLifecycleService,
} from '@moonshot-ai/agent-core-v2';
import {
  activateSkillResultSchema,
  listSkillsResponseSchema,
} from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

interface SkillWire {
  name: string;
  description: string;
  path: string;
  source: string;
  type?: string;
  disable_model_invocation?: boolean;
}

describe('server-v2 /api/v1 skills', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-skills-'));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(): Promise<string> {
    const { body } = await postJson<{ id: string }>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    expect(body.code).toBe(0);
    return body.data.id;
  }

  // The main agent scope is not created automatically on session creation
  // (server-v2 gap G10); create it here so skill activation can start a turn.
  async function createMainAgent(sessionId: string): Promise<void> {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    const agents = session.accessor.get(IAgentLifecycleService);
    if (agents.getHandle('main') === undefined) await agents.createMain();
  }

  describe('GET /api/v1/sessions/{sid}/skills', () => {
    it('returns 40401 for an unknown session', async () => {
      const { body } = await getJson<null>('/api/v1/sessions/nope/skills');
      expect(body.code).toBe(40401);
      expect(body.msg).toMatch(/does not exist/);
    });

    it('returns 40401 with an activation hint for a persisted but not activated session', async () => {
      const id = await createSession();
      // Archiving removes the session from the live map but keeps it in the index.
      const archived = await postJson<{ archived: boolean }>(`/api/v1/sessions/${id}:archive`);
      expect(archived.body.code).toBe(0);

      const { body } = await getJson<null>(`/api/v1/sessions/${id}/skills`);
      expect(body.code).toBe(40401);
      expect(body.msg).toMatch(/not activated/);
      expect(body.msg).toMatch(/activate it first/);
    });

    it('lists builtin skills projected to the wire shape', async () => {
      const id = await createSession();
      const { body } = await getJson<{ skills: SkillWire[] }>(
        `/api/v1/sessions/${id}/skills`,
      );
      expect(body.code).toBe(0);
      const skills = listSkillsResponseSchema.parse(body.data).skills;

      const updateConfig = skills.find((s) => s.name === 'update-config');
      expect(updateConfig).toBeDefined();
      expect(updateConfig).toMatchObject({ source: 'builtin' });
      // v1 parity: `isSubSkill` is never emitted on the wire.
      expect(updateConfig).not.toHaveProperty('is_sub_skill');
      expect(updateConfig).not.toHaveProperty('isSubSkill');
    });
  });

  describe('POST /api/v1/sessions/{sid}/skills/{name}:activate', () => {
    it('activates a builtin skill and returns the wire envelope', async () => {
      const id = await createSession();
      await createMainAgent(id);

      const { body } = await postJson<{ activated: boolean; skill_name: string }>(
        `/api/v1/sessions/${id}/skills/update-config:activate`,
        { args: '--help' },
      );
      expect(body.code).toBe(0);
      expect(activateSkillResultSchema.parse(body.data)).toEqual({
        activated: true,
        skill_name: 'update-config',
      });
    });

    it('returns 40415 for an unknown skill', async () => {
      const id = await createSession();
      await createMainAgent(id);

      const { body } = await postJson<null>(
        `/api/v1/sessions/${id}/skills/does-not-exist:activate`,
      );
      expect(body.code).toBe(40415);
    });

    it('returns 40401 for an unknown session', async () => {
      const { body } = await postJson<null>('/api/v1/sessions/nope/skills/update-config:activate');
      expect(body.code).toBe(40401);
      expect(body.msg).toMatch(/does not exist/);
    });

    it('rejects a bare {name} (no action) with 40001', async () => {
      const id = await createSession();
      const { body } = await postJson<null>(`/api/v1/sessions/${id}/skills/update-config`);
      expect(body.code).toBe(40001);
      expect(body.msg).toMatch(/unsupported action/);
    });

    it('rejects an unsupported action with 40001', async () => {
      const id = await createSession();
      const { body } = await postJson<null>(
        `/api/v1/sessions/${id}/skills/update-config:bogus`,
      );
      expect(body.code).toBe(40001);
      expect(body.msg).toMatch(/unsupported action/);
    });
  });
});
