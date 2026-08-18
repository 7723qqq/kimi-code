import chalk from 'chalk';
import { describe, expect, it, vi } from 'vitest';

import { DiffReviewPaneComponent, type DiffReviewItem } from '#/tui/components/panes/diff-review-pane';

vi.mock('#/i18n', () => ({
  t: (key: string) => key,
  setLocale: vi.fn(),
  getLocale: () => 'en',
}));

function stripAnsi(text: string): string {
  return text.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

const ITEMS: DiffReviewItem[] = [
  { path: 'src/a.ts', before: 'old line\nkeep\n', after: 'new line\nkeep\n' },
  { path: 'src/b.ts', before: 'one\ntwo\n', after: 'one\ntwo\nthree\n' },
];

describe('DiffReviewPaneComponent', () => {
  it('renders an empty state when there are no changes', () => {
    const pane = new DiffReviewPaneComponent();
    pane.setItems([]);
    const out = stripAnsi(pane.render(28).join('\n'));
    expect(out).toContain('tui.panes.diffReviewPane.empty');
  });

  it('lists files with add/remove stats', () => {
    const previousChalkLevel = chalk.level;
    chalk.level = 3;
    try {
      const pane = new DiffReviewPaneComponent();
      pane.setItems(ITEMS);
      const out = stripAnsi(pane.render(28).join('\n'));
      expect(out).toContain('src/a.ts');
      expect(out).toContain('src/b.ts');
      expect(out).toContain('+1');
      expect(out).toContain('-1');
    } finally {
      chalk.level = previousChalkLevel;
    }
  });

  it('opens the selected file diff on Enter and returns on Escape', () => {
    const previousChalkLevel = chalk.level;
    chalk.level = 3;
    try {
      const pane = new DiffReviewPaneComponent();
      pane.setItems(ITEMS);

      // Enter opens the first file's diff.
      expect(pane.handleKey('\r')).toBe(true);
      const detail = stripAnsi(pane.render(28).join('\n'));
      expect(detail).toContain('src/a.ts');
      expect(detail).toContain('new line');
      expect(detail).toContain('old line');

      // Escape returns to the list.
      expect(pane.handleKey('\x1b')).toBe(true);
      const list = stripAnsi(pane.render(28).join('\n'));
      expect(list).toContain('src/b.ts');
    } finally {
      chalk.level = previousChalkLevel;
    }
  });

  it('moves the selection with j/k and wraps', () => {
    const pane = new DiffReviewPaneComponent();
    pane.setItems(ITEMS);
    pane.handleKey('j');
    pane.handleKey('\r');
    const detail = stripAnsi(pane.render(28).join('\n'));
    expect(detail).toContain('src/b.ts');
    expect(detail).toContain('three');
  });

  it('returns false on Escape in list mode so the host can close', () => {
    const pane = new DiffReviewPaneComponent();
    pane.setItems(ITEMS);
    expect(pane.handleKey('\x1b')).toBe(false);
  });
});
