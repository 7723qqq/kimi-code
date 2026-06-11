// TEMP repro — markstream-vue rendering of a real chat message (delete after).
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { mount } from '@vue/test-utils';
import { MarkdownRender } from 'markstream-vue';

const text = readFileSync('/tmp/md-bug-sample.md', 'utf8');

describe('markstream repro', () => {
  it('streams the sample like the app (chunked, smooth-streaming)', async () => {
    const w = mount(MarkdownRender, {
      props: { content: '', mode: 'chat', final: false, smoothStreaming: true },
    });
    // Feed in small chunks like assistant deltas
    let acc = '';
    for (let i = 0; i < text.length; i += 24) {
      acc = text.slice(0, i + 24);
      await w.setProps({ content: acc });
      await new Promise((r) => setTimeout(r, 1));
    }
    await w.setProps({ content: text, final: true, smoothStreaming: false });
    await new Promise((r) => setTimeout(r, 1500));
    writeFileSync('/tmp/md-repro-stream.html', w.html());
  });

  it('renders with shiki code renderer (app config)', async () => {
    const w = mount(MarkdownRender, {
      props: {
        content: text,
        mode: 'chat',
        final: true,
        codeRenderer: 'shiki',
        isDark: false,
        codeBlockLightTheme: 'github-light',
        codeBlockDarkTheme: 'github-dark',
        themes: ['github-light', 'github-dark'],
      },
    });
    await new Promise((r) => setTimeout(r, 3000));
    writeFileSync('/tmp/md-repro-shiki.html', w.html());
  });
});
