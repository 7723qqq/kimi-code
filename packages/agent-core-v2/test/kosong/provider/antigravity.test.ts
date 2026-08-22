import { describe, expect, it } from 'vitest';

import type { Message, StreamedMessagePart } from '#/kosong/contract/message';
import {
  AntigravityStreamedMessage,
  buildAntigravityEnv,
  buildAntigravityPrompt,
  detectAntigravityBinary,
  getAntigravityModelCapability,
  mapModelToAntigravity,
} from '#/kosong/provider/bases/antigravity/antigravity';

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

describe('buildAntigravityPrompt thread decisions', () => {
  const msg = (role: Message['role'], text: string): Message => ({
    role,
    content: [{ type: 'text', text }],
    toolCalls: [],
  });

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
      toolCalls: [],
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
