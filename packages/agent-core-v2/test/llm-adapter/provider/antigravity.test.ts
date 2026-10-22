
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, mock } from 'bun:test';

import { type Message, type StreamedMessagePart } from '#human/llm/message';
import { AntigravityChatProvider, AntigravityStreamedMessage, buildAntigravityEnv, buildAntigravityPrompt, detectAntigravityBinary, getAntigravityModelCapability, mapModelToAntigravity } from '#human/llm/requester/bases/antigravity/antigravity';
import { createAntigravityRequester } from '#human/llm/requester/bases/antigravity/requester';

const osState = (() => ({ home: undefined as string | undefined }))();

void mock.module('node:os', () => ({
  ...nodeOs,
  homedir: () => osState.home ?? nodeOs.homedir(),
}));

const canSpawnFixtureCli = (() => {
  const probeDir = mkdtempSync(join(tmpdir(), 'agy-probe-'));
  try {
    const probe = join(probeDir, 'agy');
    writeFileSync(probe, '#!/usr/bin/env node\nprocess.exit(0);\n');
    chmodSync(probe, 0o755);
    const result = spawnSync(probe, [], { timeout: 10_000, stdio: 'ignore' });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();

describe('mapModelToAntigravity', () => {
  it('maps gemini-3.7-flash with default and custom effort', () => {
    expect(mapModelToAntigravity('gemini-3.7-flash', 'high')).toBe('gemini-3.7-flash-high');
    expect(mapModelToAntigravity('gemini-3.7-flash', 'medium')).toBe('gemini-3.7-flash-medium');
    expect(mapModelToAntigravity('gemini-3.7-flash', 'low')).toBe('gemini-3.7-flash-low');
    expect(mapModelToAntigravity('google-gemini/gemini-3.7-flash')).toBe('gemini-3.7-flash-high');
  });

  it('maps gemini-3.1-pro with low and high effort', () => {
    expect(mapModelToAntigravity('gemini-3.1-pro', 'high')).toBe('gemini-3.1-pro-high');
    expect(mapModelToAntigravity('gemini-3.1-pro', 'low')).toBe('gemini-3.1-pro-low');
    expect(mapModelToAntigravity('google-gemini/gemini-3.1-pro')).toBe('gemini-3.1-pro-high');
  });

  it('maps gemini-3.6-flash and gemini-3.5-flash', () => {
    expect(mapModelToAntigravity('gemini-3.6-flash', 'medium')).toBe('gemini-3.6-flash-medium');
    expect(mapModelToAntigravity('gemini-3.5-flash', 'low')).toBe('gemini-3.5-flash-low');
  });

  it('maps legacy gemini 2.x and 1.x models gracefully', () => {
    expect(mapModelToAntigravity('gemini-2.5-pro')).toBe('gemini-3.1-pro-high');
    expect(mapModelToAntigravity('gemini-2.5-flash')).toBe('gemini-3.7-flash-high');
    expect(mapModelToAntigravity('gemini-2.0-flash')).toBe('gemini-3.7-flash-high');
  });

  it('maps claude and gpt models to agy names', () => {
    expect(mapModelToAntigravity('claude-sonnet-4.6')).toBe('claude-sonnet-4-6');
    expect(mapModelToAntigravity('claude-opus-4.6')).toBe('claude-opus-4-6-thinking');
    expect(mapModelToAntigravity('Claude Opus 4.6 (Thinking)')).toBe('claude-opus-4-6-thinking');
    expect(mapModelToAntigravity('gpt-oss-120b')).toBe('gpt-oss-120b-medium');
    expect(mapModelToAntigravity('GPT-OSS 120B (Medium)')).toBe('gpt-oss-120b-medium');
    expect(mapModelToAntigravity('Gemini 3.5 Flash')).toBe('gemini-3.5-flash-high');
    expect(mapModelToAntigravity('Gemini 3.6 Flash (High)')).toBe('gemini-3.6-flash-high');
  });
});

describe('getAntigravityModelCapability', () => {
  it('declares only what the agy bridge actually delivers', () => {
    const caps = getAntigravityModelCapability();
    expect(caps.thinking).toBe(true);
    expect(caps.tool_use).toBe(false);
    expect(caps.image_in).toBe(false);
    expect(caps.video_in).toBe(false);
    expect(caps.audio_in).toBe(false);
  });
});

describe('buildAntigravityEnv', () => {
  it('passes through only allowlisted variables and drops the rest', () => {
    const previousHome = process.env['HOME'];
    const previousSecret = process.env['ANTIGRAVITY_TEST_SECRET'];
    try {
      process.env['ANTIGRAVITY_TEST_SECRET'] = 'leak-me';
      process.env['HOME'] = '/home/tester';
      const env = buildAntigravityEnv();
      expect(env['HOME']).toBe('/home/tester');
      expect(env['PATH']).toBeDefined();
      expect(env['ANTIGRAVITY_TEST_SECRET']).toBeUndefined();
      expect('SOME_RANDOM_TOKEN' in env).toBe(false);
    } finally {
      if (previousSecret === undefined) {
        delete process.env['ANTIGRAVITY_TEST_SECRET'];
      } else {
        process.env['ANTIGRAVITY_TEST_SECRET'] = previousSecret;
      }
      if (previousHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = previousHome;
      }
    }
  });
});

describe('AntigravityStreamedMessage', () => {
  async function* makeGenerator(parts: StreamedMessagePart[]) {
    for (const part of parts) {
      yield part;
    }
  }

  it('yields streamed message parts and stores metadata', async () => {
    const parts: StreamedMessagePart[] = [
      { type: 'think', think: 'thinking...' },
      { type: 'text', text: 'hello' },
    ];
    const msg = new AntigravityStreamedMessage(makeGenerator(parts));
    msg.setId('conv-123');
    msg.setUsage({ inputOther: 100, output: 50, inputCacheRead: 0, inputCacheCreation: 0 });
    msg.setFinishReason('completed', 'STOP');

    expect(msg.id).toBe('conv-123');
    expect(msg.usage?.output).toBe(50);
    expect(msg.finishReason).toBe('completed');
    expect(msg.rawFinishReason).toBe('STOP');

    const received: StreamedMessagePart[] = [];
    for await (const p of msg) {
      received.push(p);
    }
    expect(received).toEqual(parts);
  });
});

describe('detectAntigravityBinary', () => {
  it('detects existing binary if present on system', () => {
    const detected = detectAntigravityBinary();
    expect(detected === undefined || typeof detected === 'string').toBe(true);
  });
});

interface FakeAgyOptions {
  readonly stdout: string;
  readonly exitCode?: number;
  readonly stderrBytes?: number;
  readonly stderrBytesPerWrite?: number;
  readonly argvFile?: string;
  readonly delayMs?: number;
}

function fakeAgyScript(options: FakeAgyOptions): string {
  const lines = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
  ];
  if (options.argvFile !== undefined) {
    lines.push(
      `const argvFile = ${JSON.stringify(options.argvFile)};`,
      "fs.appendFileSync(argvFile, JSON.stringify(process.argv.slice(2)) + '\\n');",
    );
  }
  lines.push(
    `const stdout = ${JSON.stringify(options.stdout)};`,
    'if (stdout.length > 0) process.stdout.write(stdout);',
  );
  if (options.stderrBytes !== undefined) {
    lines.push(
      `let remaining = ${String(options.stderrBytes)};`,
      `const perWrite = ${String(options.stderrBytesPerWrite ?? 4096)};`,
      'const alphabet = "abcdefghijklmnopqrstuvwxyz";',
      'let template = "";',
      'while (template.length < perWrite) template += alphabet;',
      'while (remaining > 0) {',
      '  const size = Math.min(remaining, perWrite);',
      "  fs.writeSync(2, template.slice(0, size));",
      '  remaining -= size;',
      '}',
    );
  }
  lines.push(
    `const delayMs = ${String(options.delayMs ?? 120)};`,
    'setTimeout(() => process.exit(' + String(options.exitCode ?? 0) + '), delayMs);',
  );
  return lines.join('\n');
}

async function setupFakeHome(): Promise<{ home: string; binDir: string; restore: () => void }> {
  const home = await mkdtemp(join(tmpdir(), 'agy-home-'));
  const binDir = join(home, '.local', 'bin');
  await mkdir(binDir, { recursive: true });
  const previousHome = process.env['HOME'];
  const previousResolved = osState.home;
  process.env['HOME'] = home;
  osState.home = home;
  return {
    home,
    binDir,
    restore: () => {
      osState.home = previousResolved;
      if (previousHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = previousHome;
      }
    },
  };
}

async function writeFakeAgy(binDir: string, options: FakeAgyOptions): Promise<string> {
  const binary = join(binDir, 'agy');
  await writeFile(binary, fakeAgyScript(options));
  await chmod(binary, 0o755);
  return binary;
}

async function writeTranscript(home: string, conversationId: string, lines: string[]): Promise<void> {
  const dir = join(home, '.gemini', 'antigravity-cli', 'brain', conversationId, '.system_generated', 'logs');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'transcript.jsonl'), lines.map((line) => `${line}\n`).join(''));
}

const userMessage = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const assistantMessage = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  toolCalls: [],
});

describe('AntigravityChatProvider spawn behaviour', () => {
  it.skipIf(!canSpawnFixtureCli)(
    'yields the result payload and then fails when the child exits non-zero',
    async () => {
      const { home, binDir, restore } = await setupFakeHome();
      try {
        await writeFakeAgy(binDir, {
          stdout:
            '{"event":"init","conversation_id":"conv-partial"}\n' +
            '{"event":"result","result":{"response":"PARTIAL"}}\n',
          exitCode: 1,
        });
        const provider = new AntigravityChatProvider({ model: 'gemini-3.7-flash' });
        const streamed = await provider.generate('', [], [userMessage('do it')]);
        const parts: StreamedMessagePart[] = [];
        let error: unknown;
        try {
          for await (const part of streamed) {
            parts.push(part);
          }
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('exited with code 1');
        expect(parts).toEqual([{ type: 'text', text: 'PARTIAL' }]);
        expect(streamed.finishReason).toBe('error');
        expect(streamed.rawFinishReason).toBe('1');
      } finally {
        restore();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!canSpawnFixtureCli)(
    'completes without error when a result payload is followed by exit 0',
    async () => {
      const { home, binDir, restore } = await setupFakeHome();
      try {
        await writeFakeAgy(binDir, {
          stdout:
            '{"event":"init","conversation_id":"conv-ok"}\n' +
            '{"event":"result","result":{"response":"COMPLETE"}}\n',
          exitCode: 0,
        });
        const provider = new AntigravityChatProvider({ model: 'gemini-3.7-flash' });
        const streamed = await provider.generate('', [], [userMessage('do it')]);
        const parts: StreamedMessagePart[] = [];
        for await (const part of streamed) {
          parts.push(part);
        }
        expect(parts).toEqual([{ type: 'text', text: 'COMPLETE' }]);
        expect(streamed.finishReason).toBe('completed');
      } finally {
        restore();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!canSpawnFixtureCli)(
    'caps the buffered stderr tail instead of growing without bound',
    async () => {
      const { home, binDir, restore } = await setupFakeHome();
      try {
        await writeFakeAgy(binDir, { stdout: '', exitCode: 1, stderrBytes: 160 * 1024 });
        const provider = new AntigravityChatProvider({ model: 'gemini-3.7-flash' });
        const streamed = await provider.generate('', [], [userMessage('do it')]);
        let error: unknown;
        try {
          for await (const part of streamed) {
            void part;
          }
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain('exited with code 1');
        const payload = message.slice(message.indexOf(': ') + 2);
        expect(payload.length).toBeLessThanOrEqual(64 * 1024);
        expect(payload.length).toBeGreaterThan(0);
      } finally {
        restore();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!canSpawnFixtureCli)(
    'picks up transcript lines written while the child runs, including a partial line',
    async () => {
      const { home, binDir, restore } = await setupFakeHome();
      try {
        await writeFakeAgy(binDir, {
          stdout: '{"event":"init","conversation_id":"conv-live"}\n',
          exitCode: 0,
          delayMs: 2500,
        });
        const provider = new AntigravityChatProvider({ model: 'gemini-3.7-flash' });
        const streamed = await provider.generate('', [], [userMessage('do it')]);
        await writeTranscript(home, 'conv-live', []);
        const transcriptPath = join(
          home,
          '.gemini',
          'antigravity-cli',
          'brain',
          'conv-live',
          '.system_generated',
          'logs',
          'transcript.jsonl',
        );
        const firstLine = JSON.stringify({ type: 'PLANNER_RESPONSE', thinking: 'reasoning' });
        const secondLine = JSON.stringify({
          type: 'PLANNER_RESPONSE',
          thinking: 'reasoning continues',
        });
        await writeFile(transcriptPath, `${firstLine}\n${secondLine.slice(0, 24)}`);
        const parts: StreamedMessagePart[] = [];
        const consumer = (async () => {
          for await (const part of streamed) parts.push(part);
        })();
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(parts.some((part) => part.type === 'think' && part.think === 'reasoning')).toBe(
          true,
        );
        expect(
          parts.some((part) => part.type === 'think' && part.think.includes('continues')),
        ).toBe(false);
        await writeFile(transcriptPath, `${firstLine}\n${secondLine}`);
        await consumer;
        expect(parts.some((part) => part.type === 'think' && part.think === ' continues')).toBe(
          true,
        );
      } finally {
        restore();
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});

describe('createAntigravityRequester conversation continuity', () => {
  const readArgv = async (argvFile: string): Promise<string[][]> => {
    const content = await readFile(argvFile, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as string[]);
  };

  const generateOnce = async (
    requester: ReturnType<typeof createAntigravityRequester>,
    messages: Message[],
  ): Promise<void> => {
    await requester.generate(
      { model: { provider: 'antigravity', model: 'gemini-3.7-flash', capability: getAntigravityModelCapability() } },
      { messages },
      { signal: new AbortController().signal },
    );
  };

  it.skipIf(!canSpawnFixtureCli)(
    'resumes the agy thread only when the history strictly extends the previous one',
    async () => {
      const { home, binDir, restore } = await setupFakeHome();
      const argvFile = join(home, 'argv.jsonl');
      try {
        await writeFakeAgy(binDir, {
          stdout:
            '{"event":"init","conversation_id":"conv-1"}\n' +
            '{"event":"result","result":{"response":"OK"}}\n',
          exitCode: 0,
          argvFile,
        });
        const requester = createAntigravityRequester();
        await generateOnce(requester, [userMessage('q1')]);
        await generateOnce(requester, [
          userMessage('q1'),
          assistantMessage('a1'),
          userMessage('q2'),
        ]);
        const third = [userMessage('fresh-1'), assistantMessage('fresh-a'), userMessage('fresh-2')];
        await generateOnce(requester, third);

        const argv = await readArgv(argvFile);
        expect(argv).toHaveLength(3);
        const [firstArgv, secondArgv, thirdArgv] = argv;
        expect(firstArgv).not.toContain('--conversation');
        expect(firstArgv?.[firstArgv.indexOf('-p') + 1]).toBe('q1');
        expect(secondArgv?.slice(0, 2)).toEqual(['--conversation', 'conv-1']);
        const secondPrompt = secondArgv?.[secondArgv.indexOf('-p') + 1] ?? '';
        expect(secondPrompt).toBe('q2');
        expect(secondPrompt).not.toContain('[User]:');
        expect(thirdArgv).not.toContain('--conversation');
        expect(thirdArgv?.[thirdArgv.indexOf('-p') + 1]).toContain('[User]:');
      } finally {
        restore();
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});

describe('buildAntigravityPrompt thread decisions', () => {
  const msg = (role: 'user' | 'assistant', text: string): Message =>
    role === 'user'
      ? { role, content: [{ type: 'text', text }] }
      : { role, content: [{ type: 'text', text }], toolCalls: [] };

  it('rebuilds the full transcript with role markers on an unknown thread', () => {
    const plan = buildAntigravityPrompt(
      [msg('user', 'q1'), msg('assistant', 'a1'), msg('user', 'q2')],
      undefined,
    );
    expect(plan.useConversationId).toBeUndefined();
    expect(plan.promptText).toBe('[User]:\nq1\n\n[Assistant]:\na1\n\n[User]:\nq2');
  });

  it('appends only the newest message when the agy thread is known', () => {
    const plan = buildAntigravityPrompt(
      [msg('user', 'q1'), msg('assistant', 'a1'), msg('user', 'q2')],
      'conv-1',
    );
    expect(plan.useConversationId).toBe('conv-1');
    expect(plan.promptText).toBe('q2');
  });

  it('marks tool results in rebuilt transcripts and drops think parts', () => {
    const toolMsg: Message = {
      role: 'tool',
      content: [{ type: 'text', text: 'result-42' }],
      toolCallId: 'call_1',
    };
    const thinkAssistant: Message = {
      role: 'assistant',
      content: [
        { type: 'think', think: 'secret reasoning' },
        { type: 'text', text: 'visible answer' },
      ],
      toolCalls: [],
    };
    const plan = buildAntigravityPrompt(
      [msg('user', 'do it'), thinkAssistant, toolMsg, msg('user', 'next?')],
      undefined,
    );
    expect(plan.promptText).toBe(
      '[User]:\ndo it\n\n[Assistant]:\nvisible answer\n\n[Tool Result]:\nresult-42\n\n[User]:\nnext?',
    );
  });

  it('starts a fresh thread (no conversation id) when history shrank to one message', () => {
    const plan = buildAntigravityPrompt([msg('user', 'only message')], 'conv-stale');
    expect(plan.useConversationId).toBeUndefined();
    expect(plan.promptText).toBe('only message');
  });

  it('degrades an empty extraction to a placeholder prompt', () => {
    const plan = buildAntigravityPrompt(
      [{ role: 'assistant', content: [{ type: 'think', think: 'only thoughts' }], toolCalls: [] }],
      undefined,
    );
    expect(plan.promptText).toBe('hi');
  });
});
