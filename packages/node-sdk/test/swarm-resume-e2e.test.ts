/**
 * TEMPORARY end-to-end probe: a real conversation whose swarm is then resumed.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findKimiAgentAddon } from '@moonshot-ai/kimi-agent/session-handle';
import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarnessNative, type KimiHarness } from '../src/index';
import { TEST_IDENTITY } from './test-identity';

const hasNativeAddon = findKimiAgentAddon() !== null;

describe.skipIf(!hasNativeAddon)('swarm resume (real engine)', () => {
  let homeDir: string;
  let harness: KimiHarness;

  afterEach(async () => {
    await harness.close();
    for (let attempt = 0; ; attempt += 1) {
      try {
        rmSync(homeDir, { recursive: true, force: true });
        break;
      } catch {
        if (attempt >= 10) throw new Error('teardown failed');
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  });

  it('recovers every swarm member when the session is resumed', async () => {
    const { createServer } = await import('node:http');
    let calls = 0;
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        if (req.url?.includes('/chat/completions') !== true) {
          res.writeHead(404).end();
          return;
        }
        calls += 1;
        const first = calls === 1;
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
          `data: ${JSON.stringify({
            id: 'c',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'mock',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        res.write(chunk({ role: 'assistant', content: '' }));
        if (first) {
          res.write(
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: 'call_swarm',
                  type: 'function',
                  function: {
                    name: 'AgentSwarm',
                    arguments: JSON.stringify({
                      description: 'three-way smoke test',
                      prompt_template: 'do task {{item}}',
                      items: ['alpha', 'beta', 'gamma'],
                    }),
                  },
                },
              ],
            }),
          );
          res.write(chunk({}, 'tool_calls'));
        } else {
          res.write(chunk({ content: 'member done' }));
          res.write(chunk({}, 'stop'));
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    homeDir = mkdtempSync(join(tmpdir(), 'kimi-swarm-resume-'));
    harness = createKimiHarnessNative({ homeDir, identity: TEST_IDENTITY });
    writeFileSync(
      join(homeDir, 'config.toml'),
      `
[providers.local]
type = "openai"
base_url = "http://127.0.0.1:${port}/v1"
api_key = "sk-test"

[models."mock"]
provider = "local"
model = "mock"
max_context_size = 100000
`,
    );

    try {
      const session = await harness.createSession({ workDir: homeDir, model: 'mock' });
      const ended = new Promise<void>((resolve) => {
        session.onEvent((event) => {
          if (event.type === 'turn.ended') resolve();
        });
      });
      await session.prompt('run a three-way swarm');
      await ended;
      const sessionId = session.id;
      await session.close();

      // Reach the same resume path the SDK uses, and read what it rebuilt.
      const client = (
        harness as unknown as { rpc?: { resumeSession(i: unknown): Promise<unknown> } }
      ).rpc;
      console.error('=== has rpc client:', client !== undefined);
      expect(client).toBeDefined();

      const result = (await client!.resumeSession({
        id: sessionId,
        includeSubagents: true,
      })) as { agents?: Record<string, unknown> };
      const agentIds = Object.keys(result.agents ?? {});
      console.error('=== RESUMED AGENTS ===');
      console.error(JSON.stringify(agentIds, null, 2));
      console.error('model calls:', calls);

      const members = agentIds.filter((id) => id !== 'main');
      expect(members).toHaveLength(3);
    } finally {
      server.close();
    }
  }, 60_000);
});
