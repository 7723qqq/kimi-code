// apps/kimi-web/src/components/__tests__/Markdown.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import Markdown from '../Markdown.vue';

// Markdown uses vue-i18n (copy-button title); default locale is English.
const global = { plugins: [i18n] };

function render(text: string) {
  return mount(Markdown, { props: { text }, global });
}

describe('Markdown', () => {
  it('renders GFM prose (headings, links)', () => {
    const w = render('# Title\n\n[kimi](https://kimi.com)');
    expect(w.find('h1').exists()).toBe(true);
    const link = w.find('a.md-link');
    expect(link.exists()).toBe(true);
    expect(link.attributes('href')).toBe('https://kimi.com');
    expect(link.attributes('target')).toBe('_blank');
  });

  it('escapes raw HTML in prose (no injection)', () => {
    const w = render('Hello <script>alert(1)</script> world');
    expect(w.find('script').exists()).toBe(false);
    expect(w.html()).toContain('&lt;script&gt;');
  });

  it('wraps fenced code blocks with a copy button and language label', () => {
    const w = render('```ts\nconst x = 1;\n```');
    expect(w.find('.cb-wrap').exists()).toBe(true);
    expect(w.find('.cb-copy').exists()).toBe(true);
    expect(w.find('.cb-lang').text()).toBe('ts');
  });

  it('applies highlight.js token markup to a known language', () => {
    const w = render('```ts\nconst x: number = 1;\n```');
    const html = w.html();
    // hljs wraps tokens in <span class="hljs-...">. `const` is a keyword.
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
  });

  it('leaves plain / unknown-language code blocks escaped without hljs spans', () => {
    const w = render('```\n<div> & "quote"\n```');
    const code = w.find('.cb-wrap pre code');
    expect(code.exists()).toBe(true);
    // No hljs token spans for an unknown/plain block.
    expect(code.find('.hljs-keyword').exists()).toBe(false);
    // Content is escaped (no real <div> element rendered inside the code).
    expect(code.find('div').exists()).toBe(false);
    expect(code.text()).toContain('<div>');
  });

  it('colours + / - lines in a ```diff fence', () => {
    const w = render('```diff\n context line\n+added line\n-removed line\n```');
    const added = w.find('.cb-wrap pre code .diff-add');
    const removed = w.find('.cb-wrap pre code .diff-del');
    expect(added.exists()).toBe(true);
    expect(removed.exists()).toBe(true);
    expect(added.text()).toContain('added line');
    expect(removed.text()).toContain('removed line');
    expect(w.find('.cb-wrap pre code .diff-ctx').exists()).toBe(true);
  });
});
