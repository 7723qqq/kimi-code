// apps/kimi-web/src/components/__tests__/MentionMenu.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import MentionMenu from '../MentionMenu.vue';
import type { FileItem } from '../MentionMenu.vue';

const global = { plugins: [i18n] };

const items: FileItem[] = [
  { name: 'client.ts', path: 'src/api/client.ts' },
  { name: 'README.md', path: 'docs/README.md' },
  { name: 'logo.png', path: 'assets/logo.png' },
  { name: 'components', path: 'src/components/' },
  { name: 'LICENSE', path: 'LICENSE' },
];

function render(overrides: Partial<{ items: FileItem[]; activeIndex: number; loading: boolean }> = {}) {
  return mount(MentionMenu, {
    props: { items, activeIndex: 0, loading: false, ...overrides },
    global,
  });
}

describe('MentionMenu', () => {
  it('renders a file-type glyph for every row', () => {
    const w = render();
    const rows = w.findAll('.mention-item');
    expect(rows.length).toBe(items.length);
    for (const row of rows) {
      const icon = row.find('.mention-icon');
      expect(icon.exists()).toBe(true);
      // Each glyph is a line-SVG.
      expect(icon.find('svg').exists()).toBe(true);
    }
  });

  it('still shows the path text and supports selection', async () => {
    const w = render();
    const first = w.findAll('.mention-item')[0]!;
    expect(first.find('.mention-path').text()).toBe('src/api/client.ts');
    await first.trigger('mousedown');
    expect(w.emitted('select')?.[0]).toEqual([items[0]]);
  });

  it('distinguishes icon kinds (folder/doc/image differ from code)', () => {
    const w = render();
    const svgs = w.findAll('.mention-item .mention-icon').map((i) => i.html());
    // The five rows are: code, doc, image, folder, generic — at least 4 distinct SVGs.
    const distinct = new Set(svgs);
    expect(distinct.size).toBeGreaterThanOrEqual(4);
  });
});
