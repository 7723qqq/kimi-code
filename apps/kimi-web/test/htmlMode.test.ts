import { describe, expect, it } from 'vitest';
import type { AppMessage } from '../src/api/types';
import {
  buildHtmlModePrompt,
  collectHtmlModeSuggestions,
  createHtmlModeDocument,
  extractHtmlFromAssistantText,
  isHtmlModePrompt,
  stripHtmlModePrompt,
} from '../src/lib/htmlMode';
import { messagesToTurns } from '../src/composables/messagesToTurns';

describe('html mode helpers', () => {
  it('wraps and restores user prompts', () => {
    const prompt = buildHtmlModePrompt('做一个排期看板');

    expect(isHtmlModePrompt(prompt)).toBe(true);
    expect(stripHtmlModePrompt(prompt)).toBe('做一个排期看板');
  });

  it('extracts fenced html from assistant text', () => {
    const text = '```html\n<section><h1>Report</h1></section>\n```';

    expect(extractHtmlFromAssistantText(text)).toBe('<section><h1>Report</h1></section>');
  });

  it('previews unfinished fenced html while the response is streaming', () => {
    const doc = createHtmlModeDocument('```html\n<main><h1>Live preview</h1>');

    expect(doc).toContain('<main><h1>Live preview</h1>');
  });

  it('injects host css and the data-send bridge into documents', () => {
    const doc = createHtmlModeDocument('<main><button data-send="继续">继续</button></main>');

    expect(doc).toContain('data-kimi-html-mode');
    expect(doc).toContain('window.kimi');
    expect(doc).toContain('data-send="继续"');
  });

  it('collects useful data-send suggestions', () => {
    const suggestions = collectHtmlModeSuggestions(`
      <main>
        <button data-send="展开风险">展开风险</button>
        <button data-send="生成 TODO">生成 TODO</button>
      </main>
    `);

    expect(suggestions).toEqual([
      { label: '展开风险', prompt: '展开风险' },
      { label: '生成 TODO', prompt: '生成 TODO' },
    ]);
  });

  it('hides html mode wrapper in normal chat turns', () => {
    const wrapped = buildHtmlModePrompt('做一个发布检查页');
    const messages: AppMessage[] = [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'user',
        content: [{ type: 'text', text: wrapped }],
        createdAt: '2026-06-12T00:00:00.000Z',
      },
    ];

    const turn = messagesToTurns(messages, [])[0];
    expect(turn?.text).toBe('做一个发布检查页');
    expect(turn?.htmlMode).toEqual({ prompt: '做一个发布检查页' });
  });
});
