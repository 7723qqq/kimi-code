import { describe, expect, it } from 'vitest';

import {
  buildPromptContent,
  createOptimisticUserMessage,
  stampPromptId,
  withoutOptimisticMessage,
} from '../src/lib/promptContent';
import type { AppMessage, PromptAttachment } from '../src/api/types';

describe('buildPromptContent', () => {
  it('pushes the text part first when non-empty', () => {
    expect(buildPromptContent('hello')).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('emits no blocks for empty text and no attachments', () => {
    expect(buildPromptContent('')).toEqual([]);
  });

  it('maps image attachments to file-source image parts', () => {
    expect(buildPromptContent('', [{ fileId: 'f1', kind: 'image' }])).toEqual([
      { type: 'image', source: { kind: 'file', fileId: 'f1' } },
    ]);
  });

  it('maps video attachments to file-source video parts', () => {
    expect(buildPromptContent('', [{ fileId: 'f2', kind: 'video' }])).toEqual([
      { type: 'video', source: { kind: 'file', fileId: 'f2' } },
    ]);
  });

  it('fills file-part defaults for missing name/mediaType/size', () => {
    expect(buildPromptContent('', [{ fileId: 'f3', kind: 'file' }])).toEqual([
      {
        type: 'file',
        fileId: 'f3',
        name: '',
        mediaType: 'application/octet-stream',
        size: 0,
      },
    ]);
  });

  it('keeps provided file metadata', () => {
    expect(
      buildPromptContent('', [
        { fileId: 'f4', kind: 'file', name: 'a.txt', mediaType: 'text/plain', size: 3 },
      ]),
    ).toEqual([
      { type: 'file', fileId: 'f4', name: 'a.txt', mediaType: 'text/plain', size: 3 },
    ]);
  });

  it('preserves attachment order after the text part', () => {
    const content = buildPromptContent('t', [
      { fileId: 'a', kind: 'image' },
      { fileId: 'b', kind: 'file' },
      { fileId: 'c', kind: 'video' },
    ]);
    expect(content.map((c) => c.type)).toEqual(['text', 'image', 'file', 'video']);
  });
});

describe('createOptimisticUserMessage', () => {
  it('marks the message as an optimistic user echo for the session', () => {
    const msg = createOptimisticUserMessage('msg_opt_1', 'ses-1', [
      { type: 'text', text: 'hi' },
    ]);
    expect(msg.id).toBe('msg_opt_1');
    expect(msg.sessionId).toBe('ses-1');
    expect(msg.role).toBe('user');
    expect(msg.metadata).toEqual({ 'kimiWeb.optimisticUserMessage': true });
    expect(msg.createdAt).toBeTypeOf('string');
  });
});

describe('stampPromptId', () => {
  it('stamps the prompt id onto the matching optimistic message', () => {
    const msgs: AppMessage[] = [
      { id: 'other', sessionId: 's', role: 'user', content: [], createdAt: '' },
      createOptimisticUserMessage('opt', 's', []),
    ];
    const next = stampPromptId('opt', 'pr_1')(msgs);
    expect(next[1]!.promptId).toBe('pr_1');
    // Original array untouched (transcript state is replaced, not mutated).
    expect(msgs[1]!.promptId).toBeUndefined();
  });

  it('keeps an existing prompt id instead of overwriting it', () => {
    const existing = { ...createOptimisticUserMessage('opt', 's', []), promptId: 'pr_0' };
    const next = stampPromptId('opt', 'pr_1')([existing]);
    expect(next[0]!.promptId).toBe('pr_0');
  });

  it('returns the array unchanged when the optimistic message is gone', () => {
    const msgs: AppMessage[] = [
      { id: 'other', sessionId: 's', role: 'user', content: [], createdAt: '' },
    ];
    expect(stampPromptId('opt', 'pr_1')(msgs)).toBe(msgs);
  });
});

describe('withoutOptimisticMessage', () => {
  it('drops only the optimistic message', () => {
    const keep = createOptimisticUserMessage('keep', 's', []);
    const drop = createOptimisticUserMessage('drop', 's', []);
    const next = withoutOptimisticMessage('drop')([keep, drop]);
    expect(next).toEqual([keep]);
  });
});