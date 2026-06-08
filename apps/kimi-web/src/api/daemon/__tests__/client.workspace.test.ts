// apps/kimi-web/src/api/daemon/__tests__/client.workspace.test.ts
// Adapter-level tests for the workspace + :activate graceful fallbacks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonKimiWebApi } from '../client';

const config = { daemonHttpUrl: 'http://127.0.0.1:7878', clientId: 'test' };

function envelope(data: unknown, code = 0, msg = 'ok') {
  return {
    ok: true,
    json: async () => ({ code, msg, data, request_id: 'r1' }),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DaemonKimiWebApi — workspace fallbacks', () => {
  it('listWorkspaces returns [] when /workspaces errors (404-style)', async () => {
    // Daemon returns a non-zero envelope code (endpoint not shipped).
    fetchMock.mockResolvedValue(envelope(null, 40400, 'not found'));
    const api = new DaemonKimiWebApi(config);
    await expect(api.listWorkspaces()).resolves.toEqual([]);
  });

  it('listWorkspaces maps wire workspaces when present', async () => {
    fetchMock.mockResolvedValue(
      envelope({
        items: [
          {
            id: 'w1',
            root: '/Users/me/p',
            name: 'p',
            is_git_repo: true,
            branch: 'main',
            session_count: 3,
          },
        ],
      }),
    );
    const api = new DaemonKimiWebApi(config);
    const ws = await api.listWorkspaces();
    expect(ws).toEqual([
      {
        id: 'w1',
        root: '/Users/me/p',
        name: 'p',
        isGitRepo: true,
        branch: 'main',
        lastOpenedAt: undefined,
        sessionCount: 3,
      },
    ]);
  });

  it('createSession sends workspace_id AND metadata.cwd fallback', async () => {
    fetchMock.mockResolvedValue(
      envelope({
        id: 's1',
        title: '',
        created_at: '',
        updated_at: '',
        status: 'idle',
        metadata: { cwd: '/root' },
        agent_config: { model: '' },
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          total_cost_usd: 0,
          context_tokens: 0,
          context_limit: 0,
          turn_count: 0,
        },
        permission_rules: [],
        message_count: 0,
        last_seq: 0,
      }),
    );
    const api = new DaemonKimiWebApi(config);
    await api.createSession({ workspaceId: 'w1', cwd: '/root' });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.workspace_id).toBe('w1');
    expect(body.metadata).toEqual({ cwd: '/root' });
  });
});
