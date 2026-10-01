import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findKimiAgentAddon } from '@moonshot-ai/kimi-agent/session-handle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKimiHarnessNative, type KimiHarness } from '../src/index';
import { TEST_IDENTITY } from './test-identity';

// The native harness drives the Rust engine through the compiled napi addon, a
// gitignored build artifact. Skip the suite when it is absent rather than fail
// on `EngineSessionHandle.create` — a missing/stale addon must not masquerade as
// a harness regression.
const hasNativeAddon = findKimiAgentAddon() !== null;

/** A git checkout whose project root (the one holding `.git`) is `name`. */
function makeProjectCheckout(homeDir: string, name: string): string {
  const project = join(homeDir, 'projects', name);
  mkdirSync(join(project, '.git'), { recursive: true });
  return project;
}

function writeProjectLocalToml(projectRoot: string, additionalDirs: readonly string[]): void {
  mkdirSync(join(projectRoot, '.kimi-code'), { recursive: true });
  const list = additionalDirs.map((dir) => JSON.stringify(dir)).join(', ');
  writeFileSync(
    join(projectRoot, '.kimi-code', 'local.toml'),
    `[workspace]\nadditional_dir = [${list}]\n`,
    'utf-8',
  );
}

/** The extra roots a persisted session under `workDir` carries. */
async function rootsOf(
  harness: KimiHarness,
  workDir: string,
  sessionId: string,
): Promise<readonly string[]> {
  const sessions = await harness.listSessions({ workDir });
  const found = sessions.find((summary) => summary.id === sessionId);
  if (found === undefined) {
    // A missing session must fail the assertion, not read as "no roots".
    throw new Error(`session ${sessionId} is not listed under ${workDir}`);
  }
  return found.additionalDirs ?? [];
}

describe.skipIf(!hasNativeAddon)(
  'createKimiHarnessNative (Rust EngineSessionHandle backend)',
  () => {
    let homeDir: string;
    let harness: KimiHarness;

    beforeEach(() => {
      homeDir = mkdtempSync(join(tmpdir(), 'kimi-sdk-native-test-'));
      // The harness asserts the host identity at construction (it seeds the
      // engine's client identity / request headers), like the v2 client did.
      harness = createKimiHarnessNative({
        homeDir,
        identity: TEST_IDENTITY,
      });
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await harness.close();
      // Windows keeps a lock on files a killed MCP child (or the engine's
      // async runtime) still holds for a few ms after close(); retry the
      // directory removal instead of failing the test on teardown timing.
      for (let attempt = 0; ; attempt += 1) {
        try {
          rmSync(homeDir, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt >= 10) throw error;
          await new Promise((resolveTime) => setTimeout(resolveTime, 200));
        }
      }
    });

    it('creates and lists sessions via native EngineSessionHandle', async () => {
      const session = await harness.createSession({
        workDir: homeDir,
      });

      expect(session.id).toBeDefined();
      expect(session.workDir).toBe(homeDir.replaceAll('\\', '/'));

      const summaries = await harness.listSessions();
      expect(summaries.some((s) => s.id === session.id)).toBe(true);

      await session.close();
      expect(session.isClosed).toBe(true);
    });

    it('fails loud on a prompt when no provider is configured (no fake reply)', async () => {
      const session = await harness.createSession({
        workDir: homeDir,
      });

      // This throwaway home has no [providers.*] and no [agent] nativeLlmProvider,
      // so the self-contained Rust engine has no model to call. The turn must
      // surface that loudly (the host llm_chat proxy throws) rather than end with
      // the canned "Hello! I am Kimi Code." the old stub returned, which looked
      // like a real answer. The submission resolves like v1/v2's; the failure
      // surfaces through the turn.ended event stream.
      const ended = waitForTurnEnded(session);
      await expect(session.prompt('Test prompt')).resolves.toBeUndefined();
      await expect(ended).resolves.toMatchObject({ reason: 'failed' });

      await session.close();
    });

    it('authorizes the roots a trusted project keeps in .kimi-code/local.toml', async () => {
      const project = makeProjectCheckout(homeDir, 'trusted');
      const shared = join(project, 'shared');
      mkdirSync(shared);
      writeProjectLocalToml(project, [shared]);
      const expected = [shared.replaceAll('\\', '/')];

      // Untrusted: the file is part of the checkout, so it cannot widen its own
      // sandbox.
      const untrusted = await harness.createSession({ workDir: project });
      expect(await rootsOf(harness, project, untrusted.id)).toEqual([]);
      await untrusted.close();

      await harness.trustWorkspace(project);
      const session = await harness.createSession({ workDir: project });
      expect(await rootsOf(harness, project, session.id)).toEqual(expected);
      await session.close();
    });

    it('remembers a directory in the project config on persist', async () => {
      const project = makeProjectCheckout(homeDir, 'remember');
      const shared = join(project, 'shared');
      mkdirSync(shared);
      await harness.trustWorkspace(project);

      const session = await harness.createSession({ workDir: project });
      const result = await session.addAdditionalDir(shared, { persist: true });
      expect(result.persisted).toBe(true);
      expect(result.configPath).toBe(
        join(project, '.kimi-code', 'local.toml').replaceAll('\\', '/'),
      );
      const written = readFileSync(result.configPath, 'utf-8');
      expect(written).toContain('additional_dir');
      await session.close();

      // The next session of the project starts with the remembered root without
      // anyone adding it again.
      const next = await harness.createSession({ workDir: project });
      expect(await rootsOf(harness, project, next.id)).toEqual([shared.replaceAll('\\', '/')]);
      await next.close();
    });

    it('keeps a session-only directory out of the project config', async () => {
      const project = makeProjectCheckout(homeDir, 'session-only');
      const shared = join(project, 'shared');
      mkdirSync(shared);
      await harness.trustWorkspace(project);

      const session = await harness.createSession({ workDir: project });
      const result = await session.addAdditionalDir(shared, { persist: false });
      expect(result.persisted).toBe(false);
      expect(existsSync(join(project, '.kimi-code', 'local.toml'))).toBe(false);
      // `persist: false` means "this session", not "rejected": the directory is
      // authorized even though nothing was written.
      expect(result.additionalDirs).toEqual([shared.replaceAll('\\', '/')]);
      await session.close();
    });

    it('never hands an untrusted project file its roots back as requested ones', async () => {
      // The checkout ships a `local.toml` naming a directory outside itself. While
      // the workspace is untrusted that file must stay invisible — including in
      // the result of `/add-dir … remember`, which the TUI feeds back in as the
      // next session's requested roots.
      const project = makeProjectCheckout(homeDir, 'untrusted-planted');
      const planted = join(project, '..', 'planted');
      const mine = join(project, 'mine');
      mkdirSync(planted, { recursive: true });
      mkdirSync(mine);
      writeProjectLocalToml(project, [planted]);

      const session = await harness.createSession({ workDir: project });
      expect(await rootsOf(harness, project, session.id)).toEqual([]);

      const result = await session.addAdditionalDir(mine, { persist: true });
      expect(result.additionalDirs).toEqual([mine.replaceAll('\\', '/')]);
      expect(result.additionalDirs).not.toContain(planted.replaceAll('\\', '/'));
      await session.close();

      // The next session sees neither the file's list nor anything the previous
      // result could have smuggled into the caller's list.
      const next = await harness.createSession({ workDir: project });
      expect(await rootsOf(harness, project, next.id)).toEqual([]);
      await next.close();
    });

    it('withdraws the project roots when the workspace is no longer trusted', async () => {
      // These roots come from the file, not from the caller's list, so they are
      // re-read per session: revoking trust has to take them away again.
      const project = makeProjectCheckout(homeDir, 'revoked');
      const shared = join(project, 'shared');
      mkdirSync(shared);
      writeProjectLocalToml(project, [shared]);
      await harness.trustWorkspace(project);

      const session = await harness.createSession({ workDir: project });
      expect(await rootsOf(harness, project, session.id)).toEqual([shared.replaceAll('\\', '/')]);
      await session.close();

      // Withdraw trust the way the store records it.
      writeFileSync(join(homeDir, 'trusted-workspaces.json'), '[]', 'utf-8');
      const after = await harness.createSession({ workDir: project });
      expect(await rootsOf(harness, project, after.id)).toEqual([]);
      await after.close();
    });

    it('forwards native-LLM step and subagent lifecycle events to onEvent', async () => {
      // The Rust engine calls the model over HTTP itself (native LLM), so the
      // step / subagent events it emits have no host-proxy equivalent. This test
      // pins the SDK's mapping of them onto the protocol union: without it the
      // TUI's step counter and subagent cards stayed empty.
      const { createServer } = await import('node:http');
      const calls = { count: 0 };
      const server = createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
          if (req.url?.includes('/chat/completions') !== true) {
            res.writeHead(404).end();
            return;
          }
          calls.count += 1;
          const first = calls.count === 1;
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
                    id: 'call_agent',
                    type: 'function',
                    function: {
                      name: 'Agent',
                      arguments: '{"prompt":"say hi","description":"greet"}',
                    },
                  },
                ],
              }),
            );
            res.write(chunk({}, 'tool_calls'));
          } else {
            res.write(chunk({ content: 'done' }));
            res.write(chunk({}, 'stop'));
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      try {
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

        const session = await harness.createSession({ workDir: homeDir, model: 'mock' });
        const types: string[] = [];
        session.onEvent((event) => types.push(event.type));
        const ended = waitForTurnEnded(session);
        await session.prompt('hi');
        await ended;

        expect(types).toContain('turn.step.started');
        expect(types).toContain('turn.step.completed');
        expect(types).toContain('subagent.spawned');
        expect(types).toContain('subagent.started');
        expect(types).toContain('subagent.completed');
        await session.close();
      } finally {
        server.close();
      }
    }, 20_000);

    it('addresses each turn of a session to its own id', async () => {
      // The ids, not just the event names. Every event the SDK synthesizes
      // inside a turn — the step boundaries from `llm.step.begin` / `end`, the
      // deltas — is stamped from the turn in flight, so an id that collapses
      // (every turn reading as 0) files the whole session under one turn while
      // every event name stays exactly as it should. Two turns in one session
      // is what makes that visible: the second must not reuse the first's id.
      const { createServer } = await import('node:http');
      const server = createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
          if (req.url?.includes('/chat/completions') !== true) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'close',
          });
          const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
            `data: ${JSON.stringify({
              id: 'c',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'mock',
              choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`;
          res.write(chunk({ role: 'assistant', content: 'hi' }));
          res.write(chunk({}, 'stop'));
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      try {
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

        const session = await harness.createSession({ workDir: homeDir, model: 'mock' });
        const seen: Array<{ type: string; turnId: unknown }> = [];
        session.onEvent((event) => {
          seen.push({
            type: event.type,
            turnId: (event as { turnId?: unknown }).turnId,
          });
        });
        const runTurn = async (prompt: string): Promise<void> => {
          const ended = waitForTurnEnded(session);
          await session.prompt(prompt);
          await ended;
        };
        await runTurn('first');
        const firstTurnEnd = seen.findIndex((event) => event.type === 'turn.ended');
        await runTurn('second');
        await session.close();

        const firstTurn = seen.slice(0, firstTurnEnd + 1);
        const secondTurn = seen.slice(firstTurnEnd + 1);
        const firstId = firstTurn.find((event) => event.type === 'turn.started')?.turnId;
        const secondId = secondTurn.find((event) => event.type === 'turn.started')?.turnId;
        expect(typeof firstId).toBe('number');
        expect(secondId).toBe((firstId as number) + 1);

        const stepTypes = new Set([
          'turn.step.started',
          'turn.step.completed',
          'assistant.delta',
        ]);
        for (const turn of [
          { events: firstTurn, id: firstId },
          { events: secondTurn, id: secondId },
        ]) {
          const steps = turn.events.filter((event) => stepTypes.has(event.type));
          expect(steps.length).toBeGreaterThan(0);
          for (const step of steps) {
            expect(step.turnId).toBe(turn.id);
          }
        }
      } finally {
        server.close();
      }
    }, 30_000);

    it('emits the engine turn telemetry with the host-injected context', async () => {
      // v2 #3963: the engine emits turn_started / turn_ended through the
      // host/telemetry seam, the host-injected context (mode, provider_type,
      // protocol, thinking_effort, enabled_plugins) merged with the
      // engine-observed outcome. The SDK wires both halves — the context at
      // handle build and the callback forwarding — so a host that injects a
      // telemetry client receives them; without that wiring the events died at
      // the addon boundary.
      const { createServer } = await import('node:http');
      const server = createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
          if (req.url?.includes('/chat/completions') !== true) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'close',
          });
          const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
            `data: ${JSON.stringify({
              id: 'c',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'mock',
              choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`;
          res.write(chunk({ role: 'assistant', content: 'hi' }));
          res.write(chunk({}, 'stop'));
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;

      const recorded: { event: string; properties?: Record<string, unknown> }[] = [];
      const telemetry = {
        track: (event: string, properties?: Record<string, unknown>) => {
          recorded.push({ event, ...(properties === undefined ? {} : { properties }) });
        },
      };
      try {
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

        const localHarness = createKimiHarnessNative({
          homeDir,
          identity: TEST_IDENTITY,
          telemetry,
        });
        const session = await localHarness.createSession({ workDir: homeDir, model: 'mock' });
        const ended = waitForTurnEnded(session);
        await session.prompt('hi');
        await ended;
        await session.close();
        await localHarness.close();

        const started = recorded.find((entry) => entry.event === 'turn_started');
        expect(started?.properties).toMatchObject({
          mode: 'agent',
          provider_type: 'openai',
          protocol: 'openai',
          thinking_effort: 'medium',
        });
        // The enabled-plugin set is deliberately not snapshotted at session
        // creation (reading the registry would open the engine's SQLite store
        // there), so the field stays absent — v2's "no plugin snapshot" case.
        expect(started?.properties).not.toHaveProperty('enabled_plugins');
        const turnEnded = recorded.find((entry) => entry.event === 'turn_ended');
        expect(turnEnded?.properties).toMatchObject({ reason: 'completed' });
        expect(typeof turnEnded?.properties?.['steps']).toBe('number');
        expect(String(turnEnded?.properties?.['trace_id'])).toMatch(/^turn-/);
        expect(typeof turnEnded?.properties?.['duration_ms']).toBe('number');
      } finally {
        server.close();
      }
    }, 20_000);

    it('forwards background-task lifecycle events to onEvent', async () => {
      // The per-pipeline task runner only reports if its sink is wired to the
      // host callbacks; before that wiring the TUI's `background.task.*` handlers
      // never fired.
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
                    id: 'call_bg',
                    type: 'function',
                    function: {
                      name: 'Bash',
                      arguments: JSON.stringify({
                        command: 'echo background hello',
                        run_in_background: true,
                        description: 'probe bg task',
                      }),
                    },
                  },
                ],
              }),
            );
            res.write(chunk({}, 'tool_calls'));
          } else {
            res.write(chunk({ content: 'done' }));
            res.write(chunk({}, 'stop'));
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      try {
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

        const session = await harness.createSession({ workDir: homeDir, model: 'mock' });
        // `Bash` is not in the default-approve set, so manual mode would park on
        // an approval the throwaway home cannot answer.
        await session.setPermission('yolo');

        const started: unknown[] = [];
        const terminated: unknown[] = [];
        session.onEvent((event) => {
          if (event.type === 'background.task.started') started.push(event.info);
          if (event.type === 'background.task.terminated') terminated.push(event.info);
        });

        const ended = waitForTurnEnded(session);
        await session.prompt('run a background task');
        await ended;
        // The task settles asynchronously after the turn.
        for (let i = 0; i < 100 && terminated.length === 0; i += 1) {
          await new Promise((r) => setTimeout(r, 20));
        }

        expect(started[0]).toMatchObject({ description: 'probe bg task', kind: 'process' });
        expect(terminated[0]).toMatchObject({ description: 'probe bg task', kind: 'process' });
        await session.close();
      } finally {
        server.close();
      }
    }, 20_000);

    it('keeps a live permission mode when plan mode is on and the handle rebuilds', async () => {
      // `plan` is not a permission mode: v2's `PermissionMode` is
      // `manual | yolo | auto` and plan mode is a tool guard of its own
      // (`AgentPlanService.guardToolExecution`). Folding `meta.planMode` into
      // the policy snapshot's mode made the engine degrade to its manual
      // default, so a yolo session in plan mode asked for every Bash command —
      // and every rebuild (setThinking / setModel / additionalDirs) re-baked it.
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
                    id: 'call_plan_mode',
                    type: 'function',
                    function: {
                      name: 'Bash',
                      arguments: JSON.stringify({
                        command: 'echo plan_guard_marker',
                        description: 'probe',
                      }),
                    },
                  },
                ],
              }),
            );
            res.write(chunk({}, 'tool_calls'));
          } else {
            res.write(chunk({ content: 'done' }));
            res.write(chunk({}, 'stop'));
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      try {
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

        const session = await harness.createSession({ workDir: homeDir, model: 'mock' });
        const approvals: string[] = [];
        session.setApprovalHandler(async (request) => {
          approvals.push(request.toolName);
          return { decision: 'approved' };
        });
        const outputs: string[] = [];
        session.onEvent((event) => {
          const rec = event as { type: string; output?: unknown };
          if (rec.type === 'tool.result' && rec.output !== undefined) {
            outputs.push(JSON.stringify(rec.output));
          }
        });

        await session.setPermission('yolo');
        await session.setPlanMode(true);
        // setThinking always rebuilds the handle, which re-bakes the snapshot.
        await session.setThinking('low');

        const ended = waitForTurnEnded(session);
        await session.prompt('run the probe command');
        await ended;
        // The command must actually have run, or an empty approval list would
        // pass for the wrong reason.
        expect(outputs.join('\n')).toContain('plan_guard_marker');
        expect(approvals).toEqual([]);
        await session.close();
      } finally {
        server.close();
      }
    }, 20_000);

    it('emits goal.updated when a goal is created', async () => {
      // The goal panel is driven by `goal.updated`; nothing emitted it, so a
      // goal created through the SDK never reached the UI.
      const session = await harness.createSession({ workDir: homeDir });
      const snapshots: unknown[] = [];
      session.onEvent((event) => {
        if (event.type === 'goal.updated') snapshots.push(event.snapshot);
      });

      await session.createGoal({ objective: 'ship the feature' });

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ objective: 'ship the feature', status: 'active' });
      await session.close();
    });

    it('supports cancel on active or idle sessions', async () => {
      const session = await harness.createSession({
        workDir: homeDir,
      });

      await expect(session.cancel()).resolves.toBeUndefined();
      await session.close();
    });

    it('fails loud on steer when no provider is configured', async () => {
      const session = await harness.createSession({
        workDir: homeDir,
      });

      // steer on an idle session starts a turn, which hits the same missing-model
      // path as prompt: the submission resolves and the turn fails loudly through
      // the event stream rather than silently succeeding.
      const ended = waitForTurnEnded(session);
      await expect(session.steer('Steer instruction')).resolves.toBeUndefined();
      await expect(ended).resolves.toMatchObject({ reason: 'failed' });
      await session.close();
    }, 15_000);

    it('suggests workspace files with match positions from the engine search', async () => {
      writeFileSync(join(homeDir, 'alpha.txt'), 'a');
      writeFileSync(join(homeDir, 'beta.txt'), 'b');

      const result = await harness.suggestFiles(homeDir, { query: 'alpha', limit: 20 });

      expect(result).toBeDefined();
      expect(result?.items).toHaveLength(1);
      expect(result?.items[0]).toMatchObject({
        path: 'alpha.txt',
        name: 'alpha.txt',
        kind: 'file',
        matchPositions: [0, 1, 2, 3, 4],
      });
      expect(result?.truncated).toBe(false);
    });

    it('lists the configured MCP servers before a session exists', async () => {
      writeFileSync(
        join(homeDir, 'mcp.json'),
        JSON.stringify({ mcpServers: { example: { command: 'node', args: ['server.mjs'] } } }),
      );

      const servers = await harness.listWorkspaceMcpServers(homeDir);

      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({
        name: 'example',
        transport: 'stdio',
        status: 'pending',
      });
    });

    it('installs a plugin and exposes the commands its manifest declares', async () => {
      const marketplaceDir = join(homeDir, 'marketplace');
      const pluginRoot = join(marketplaceDir, 'official', 'demo');
      mkdirSync(join(pluginRoot, 'commands'), { recursive: true });
      // Declared below, so it has to exist: the engine drops a `skills` path
      // that is not a directory and says so in `diagnostics`.
      mkdirSync(join(pluginRoot, 'skills'), { recursive: true });
      writeFileSync(
        join(marketplaceDir, 'marketplace.json'),
        JSON.stringify({
          version: '1',
          plugins: [
            {
              id: 'demo',
              tier: 'official',
              displayName: 'Demo',
              description: 'A demo plugin',
              source: './official/demo',
            },
          ],
        }),
      );
      writeFileSync(
        join(pluginRoot, 'kimi.plugin.json'),
        JSON.stringify({
          name: 'demo',
          version: '1.0.0',
          keywords: ['demo', 'voice'],
          skills: './skills/',
          sessionStart: { skill: 'demo.onboard' },
          skillInstructions: 'Answer in the house voice.',
          interface: { developerName: 'Example' },
          commands: [{ path: './commands/review.md' }],
        }),
      );
      writeFileSync(
        join(pluginRoot, 'commands', 'review.md'),
        '---\ndescription: Review the diff\n---\n\nReview $ARGUMENTS\n',
      );
      vi.stubEnv('KIMI_CODE_PLUGIN_MARKETPLACE_DIR', marketplaceDir);

      // The built-in normify plugin seeds itself on the first plugin API call;
      // the registry starts with exactly that one entry.
      expect(await harness.listPlugins()).toEqual([
        expect.objectContaining({ id: 'normify', enabled: true }),
      ]);

      const installed = await harness.installPlugin('demo');
      expect(installed).toMatchObject({ id: 'demo', enabled: true });

      const info = await harness.getPluginInfo('demo');
      expect(info).toMatchObject({ id: 'demo', commandCount: 1, state: 'ok' });
      expect(info.commands?.[0]).toMatchObject({
        pluginId: 'demo',
        name: 'review',
        description: 'Review the diff',
        body: 'Review $ARGUMENTS',
      });

      // The plugin panel's manifest-derived lines read these off `info`. The
      // engine used to send none of them, so the skills list, the session-start
      // skill, the plugin instructions, the interface block and the keywords all
      // rendered as nothing. `skills` in particular arrives as a resolved list,
      // which the panel iterates directly.
      expect(info.manifestKind).toBe('kimi-plugin-root');
      expect(info.manifestPath).toContain('kimi.plugin.json');
      expect(info.shadowedManifestPath).toBeUndefined();
      expect(info.installedAt).toEqual(expect.any(String));
      expect(info.originalSource).toBe('./official/demo');
      expect(info.manifest?.sessionStart?.skill).toBe('demo.onboard');
      expect(info.manifest?.skillInstructions).toBe('Answer in the house voice.');
      expect(info.manifest?.keywords).toEqual(['demo', 'voice']);
      expect(info.manifest?.interface?.developerName).toBe('Example');
      expect(info.manifest?.skills).toHaveLength(1);
      expect(info.manifest?.skills?.[0]).toContain('skills');
      // Omitted rather than sent empty, so a clean plugin's info carries no
      // diagnostics key at all; the panel's `?? []` is what turns that into "no
      // problems".
      expect(info.diagnostics).toBeUndefined();

      // `source` is the v2 vocabulary, not the string that was typed, and
      // `originalSource` is the pre-resolution spelling. The host pairs the two:
      // `formatPluginSourceLabel` and `pluginTrustLabel` branch on
      // `source === 'github' | 'zip-url'` and then read `originalSource` /
      // `github`. The engine used to send the raw `"./official/demo"` here, so
      // every such comparison missed and the badge came out "third-party".
      expect(info.source).toBe('local-path');
      expect(info.github).toBeUndefined();
      const summary = (await harness.listPlugins()).find((plugin) => plugin.id === 'demo');
      expect(summary?.source).toBe('local-path');
      expect(summary?.originalSource).toBe('./official/demo');

      const commands = await harness.listPluginCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0]?.name).toBe('review');

      // The summary the panel renders carries the same live state and counts as
      // the detail view; without them every count read as undefined.
      expect((await harness.listPlugins())[0]).toMatchObject({
        id: 'demo',
        state: 'ok',
        commandCount: 1,
      });

      // An unknown command is refused by name, not silently submitted.
      const session = await harness.createSession({ workDir: homeDir });
      await expect(session.activatePluginCommand('demo', 'nope', '')).rejects.toThrow(
        /was not found/,
      );

      // A known one submits the expanded body as a turn.
      const ended = waitForTurnEnded(session);
      await expect(
        session.activatePluginCommand('demo', 'review', 'src/'),
      ).resolves.toBeUndefined();
      await expect(ended).resolves.toMatchObject({ reason: 'failed' });
      await session.close();

      // Disabling the plugin drops its commands from the slash-command source.
      await harness.setPluginEnabled('demo', false);
      expect(await harness.listPluginCommands()).toEqual([]);

      await harness.removePlugin('demo');
      // Removing the demo plugin leaves the built-in normify plugin — the
      // seeder never re-adds a catalog plugin, and normify is not one.
      expect(await harness.listPlugins()).toEqual([
        expect.objectContaining({ id: 'normify', enabled: true }),
      ]);

      // The registry landed in the app-scope engine store — the same
      // `<home>/agent/sessions.db` the hosted server opens, not a second store
      // under `<home>` that only the CLI would see.
      expect(existsSync(join(homeDir, 'agent', 'sessions.db'))).toBe(true);
      expect(existsSync(join(homeDir, 'sessions.db'))).toBe(false);
    });
  },
);

function waitForTurnEnded(session: {
  onEvent(
    listener: (event: { readonly type: string; readonly reason?: string }) => void,
  ): () => void;
}): Promise<{ readonly reason?: string }> {
  return new Promise((resolve) => {
    const unsubscribe = session.onEvent((event) => {
      if (event.type === 'turn.ended') {
        unsubscribe();
        resolve(event);
      }
    });
  });
}
