import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findKimiAgentAddon } from '@moonshot-ai/kimi-agent/session-handle';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createKimiHarnessNative, type KimiHarness } from '../src/index';
import { TEST_IDENTITY } from './test-identity';

declare global {
  var __kimiAcceptTool: string;
  var __kimiAcceptArgs: Record<string, unknown> | undefined;
}

const hasNativeAddon = findKimiAgentAddon() !== null;

/**
 * End-to-end acceptance for the permission chain: a real napi engine, a real
 * git work tree on disk, and a real write target. Each case drives one tool
 * call through a turn and observes two independent facts — whether the host was
 * asked for approval, and whether the target file actually changed on disk.
 *
 * Unit tests can only assert the verdict; they cannot show that an approval
 * prompt reaches the user, which is the behaviour under test here.
 */
describe('permission acceptance (real engine, real filesystem)', () => {

  let homeDir: string;
  let port = 0;
  let server: ReturnType<typeof import('node:http').createServer> | undefined;

  beforeAll(async () => {
    if (!hasNativeAddon) return;
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-perm-accept-'));
    const { createServer } = await import('node:http');
    let calls = 0;
    server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        if (req.url?.includes('/chat/completions') !== true) {
          res.writeHead(404).end();
          return;
        }
        calls += 1;
        // One turn = a tool call, then a text stop after the tool result.
        if (calls > 2) calls = 1;
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const chunk = (payload: Record<string, unknown>) =>
          `data: ${JSON.stringify({
            id: `chatcmpl-${calls}`,
            object: 'chat.completion.chunk',
            created: Date.now(),
            model: 'mock',
            choices: [{ index: 0, delta: payload, finish_reason: null }],
          })}\n\n`;
        res.write(chunk({ role: 'assistant', content: '' }));
        if (calls === 1) {
          const args = globalThis.__kimiAcceptArgs as Record<string, unknown> | undefined;
          res.write(
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: `call_${calls}`,
                  type: 'function',
                  function: {
                    name: globalThis.__kimiAcceptTool,
                    arguments: JSON.stringify(args ?? {}),
                  },
                },
              ],
            }),
          );
        } else {
          res.write(chunk({ content: 'done' }));
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server?.close();

    if (homeDir !== undefined) {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  async function runCase(options: {
    tool: string;
    args: Record<string, unknown>;
    mode: 'manual' | 'yolo' | 'auto';
    planMode?: boolean;
    workspace?: 'inside' | 'outside' | 'git';
    additionalDirs?: string[];
    workTree?: boolean;
  }) {
    const work = mkdtempSync(join(tmpdir(), 'kimi-perm-work-'));
    const granted = mkdtempSync(join(tmpdir(), 'kimi-perm-granted-'));
    if (options.workTree !== false) {
      mkdirSync(join(work, '.git'));
    }
    const target =
      options.workspace === 'git'
        ? join(work, '.git', 'CMSG9.txt')
        : options.workspace === 'outside'
          ? join(granted, 'outside.txt')
          : join(work, 'src', 'lib.rs');
    if (options.workspace !== 'git') {
      // Deliberately no pre-created file: the stale guard rejects a write to
      // a file this agent has not read yet, and each case drives a single
      // tool call, so an existing target could never be overwritten here.
      mkdirSync(join(target, '..'), { recursive: true });
    }

    const args = { ...options.args };
    const first = Object.keys(options.args)[0];
    if (first !== undefined && typeof options.args[first] === 'string') {
      args[first] = (options.args[first] as string).replaceAll('TARGET', target);
    }

    globalThis.__kimiAcceptTool = options.tool;
    globalThis.__kimiAcceptArgs = args;

    writeFileSync(
      join(homeDir, 'config.toml'),
      [
        'default_model = "mock"',
        '',
        '[providers.local]',
        'type = "openai"',
        `base_url = "http://127.0.0.1:${port}/v1"`,
        'api_key = "sk-test"',
        '',
        '[models."mock"]',
        'provider = "local"',
        'model = "mock"',
        'max_context_size = 100000',
        '',
        '[agent]',
        'nativeLlmProvider = "local"',
        '',
      ].join('\n'),
    );

    const local = createKimiHarnessNative({ homeDir, identity: TEST_IDENTITY });
    const session = await local.createSession({
      workDir: work,
      model: 'mock',
      permission: options.mode,
      ...(options.additionalDirs !== undefined && options.additionalDirs.length > 0
        ? {
            additionalDirs: options.additionalDirs.map((dir) =>
              dir.replaceAll('GRANTED', granted),
            ),
          }
        : undefined),
    });
    const approvals: { toolName: string; reason?: string }[] = [];
    session.setApprovalHandler(async (request) => {
      approvals.push({ toolName: request.toolName, reason: request.reason });
      return { decision: 'approved' };
    });
    await session.setPermission(options.mode);
    if (options.planMode === true) {
      await session.setPlanMode(true);
    }

    const seen: string[] = [];
    const ended = new Promise<void>((resolve) => {
      session.onEvent(
        (event) => {
          seen.push(event.type);
          if (event.type === 'error') {
            console.log(`[accept][error] ${JSON.stringify(event).slice(0, 500)}`);
          }
          if (event.type === 'turn.ended' || event.type === 'turn.cancel') resolve();
        },
      );
    });
    await session.prompt('run the tool');
    await Promise.race([ended, new Promise<void>((r) => setTimeout(r, 30_000))]);

    const written = existsSync(target) && readFileSync(target, 'utf8') === 'after';
    const result = { approvals, written, target, seen: seen.join(',') };
    console.log(
      `[accept] ${options.mode}/${options.tool}/${options.workspace ?? 'inside'} approvals=${JSON.stringify(approvals)} written=${written} events=${result.seen}`,
    );
    await session.close();
    await local.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(granted, { recursive: true, force: true });
    return result;
  }

  it.skipIf(!hasNativeAddon)(
    'yolo writes inside the work tree without asking',
    async () => {
      const out = await runCase({
        tool: 'Write',
        args: { path: 'TARGET', content: 'after' },
        mode: 'yolo',
        workspace: 'inside',
      });
      expect(out.approvals).toEqual([]);
      expect(out.written).toBe(true);
    },
    60_000,
  );

  it.skipIf(!hasNativeAddon)(
    'yolo keeps its mode inside plan mode (no prompt for Bash)',
    async () => {
      const out = await runCase({
        tool: 'Bash',
        args: { command: 'echo acceptance_marker' },
        mode: 'yolo',
        planMode: true,
      });
      expect(out.approvals).toEqual([]);
    },
    60_000,
  );

  it.skipIf(!hasNativeAddon)(
    'Bash mentioning a .git path is not a file access',
    async () => {
      const out = await runCase({
        tool: 'Bash',
        args: { command: 'cat TARGET/.git/config' },
        mode: 'yolo',
      });
      expect(out.approvals).toEqual([]);
    },
    60_000,
  );

  it.skipIf(!hasNativeAddon)(
    'an /add-dir target is approved once authorized',
    async () => {
      const out = await runCase({
        tool: 'Write',
        args: { path: 'TARGET', content: 'after' },
        mode: 'manual',
        workspace: 'outside',
        additionalDirs: ['GRANTED'],
      });
      if (process.platform === 'win32') {
        // v2's git-cwd-write-approve returns early unless pathClass is
        // 'posix', so a local Windows runtime auto-approves no writes: manual
        // mode asks here exactly as it does for an in-project target.
        expect(out.approvals.length).toBeGreaterThan(0);
        expect(out.approvals[0]?.reason).toContain('requires approval');
      } else {
        // On posix the target sits inside {workspaceDir, additionalDirs} of a
        // git work tree, so GitCwdWriteApprove answers without a prompt.
        expect(out.approvals).toEqual([]);
      }
      expect(out.written).toBe(true);
    },
    60_000,
  );

  it.skipIf(!hasNativeAddon)(
    'a .git control path still asks in yolo',
    async () => {
      const out = await runCase({
        tool: 'Write',
        args: { path: 'TARGET', content: 'after' },
        mode: 'yolo',
        workspace: 'git',
      });
      expect(out.approvals).not.toEqual([]);
    },
    60_000,
  );

  it.skipIf(!hasNativeAddon)(
    'a non-work-tree workspace does not auto-approve writes in manual',
    async () => {
      const out = await runCase({
        tool: 'Write',
        args: { path: 'TARGET', content: 'after' },
        mode: 'manual',
        workspace: 'inside',
        workTree: false,
      });
      expect(out.approvals).not.toEqual([]);
    },
    60_000,
  );
});
