import { describe, expect, it, vi } from 'vitest';

import { PromptOptimizePanelComponent } from '#/tui/components/dialogs/prompt-optimize-panel';

vi.mock('#/i18n', () => ({
  t: (key: string, params?: Record<string, string | number>): string => {
    const translations: Record<string, string> = {
      'tui.dialogs.promptOptimize.title': 'Rewrite this prompt',
      'tui.dialogs.promptOptimize.hint': '{{accept}} accept · {{discard}} discard',
      'tui.dialogs.promptOptimize.accept': 'Accept rewrite',
      'tui.dialogs.promptOptimize.discard': 'Keep original',
    };
    const msg = translations[key] ?? key;
    if (params === undefined) return msg;
    let result = msg;
    for (const [k, v] of Object.entries(params)) {
      result = result.replaceAll(`{{${k}}}`, String(v));
    }
    return result;
  },
}));

const ESC = '\u001B';
const ENTER = '\r';
const LEFT = '\u001B[D';
const RIGHT = '\u001B[C';

function makePanel() {
  const onSelect = vi.fn();
  const panel = new PromptOptimizePanelComponent({
    original: 'fix the parser',
    optimized: 'Rewrite the parser to reject trailing input.',
    onSelect,
  });
  return { panel, onSelect };
}

describe('PromptOptimizePanelComponent', () => {
  it('accepts on Enter by default', () => {
    const { panel, onSelect } = makePanel();
    panel.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledWith('accept');
  });

  it('discards on Escape', () => {
    const { panel, onSelect } = makePanel();
    panel.handleInput(ESC);
    expect(onSelect).toHaveBeenCalledWith('discard');
  });

  it('moves the selection with the arrow keys and accepts the highlighted choice', () => {
    const { panel, onSelect } = makePanel();
    panel.handleInput(RIGHT);
    panel.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledWith('discard');
  });

  it('returns to accept with the opposite arrow', () => {
    const { panel, onSelect } = makePanel();
    panel.handleInput(RIGHT);
    panel.handleInput(LEFT);
    panel.handleInput(ENTER);
    expect(onSelect).toHaveBeenCalledWith('accept');
  });

  it('renders both the original and the rewrite', () => {
    const { panel } = makePanel();
    const rendered = panel.render(80).join('\n');
    expect(rendered).toContain('fix the parser');
    expect(rendered).toContain('Rewrite the parser to reject trailing input.');
  });

  it('never exceeds the requested width', () => {
    const { panel } = makePanel();
    for (const line of panel.render(40)) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });
});
