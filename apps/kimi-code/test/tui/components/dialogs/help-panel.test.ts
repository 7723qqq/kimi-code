import { describe, expect, it, mock } from 'bun:test';

import { HelpPanelComponent } from '#/tui/components/dialogs/help-panel';
import { mouse } from '#test/helpers/mouse';

const ANSI_SGR = /\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function makePanel(commandCount = 60): HelpPanelComponent {
  return new HelpPanelComponent({
    commands: Array.from({ length: commandCount }, (_, index) => ({
      name: `cmd${index}`,
      aliases: [],
      description: `description ${index}`,
    })),
    shortcuts: [],
    onClose: mock(),
    maxVisible: 24,
  });
}

describe('HelpPanelComponent — mouse', () => {
  it('scrolls its own content with the wheel instead of leaving it to the transcript', () => {
    const panel = makePanel();
    panel.focused = true;
    const before = panel.render(80).map(strip);
    expect(before.at(-2)).toContain('showing 1-');

    const moved = panel.handleMouse(mouse('wheel', 5, 1));
    expect(moved?.handled).toBe(true);
    expect(moved?.render).toBe(true);

    const after = panel.render(80).map(strip);
    expect(after.at(-2)).toContain('showing 4-');
    expect(after.join('\n')).not.toBe(before.join('\n'));
  });

  it('does not scroll past the end of the content', () => {
    const panel = makePanel();
    panel.focused = true;
    panel.render(80);

    for (let i = 0; i < 20; i++) panel.handleMouse(mouse('wheel', 5, 1));
    const scrolled = panel.handleMouse(mouse('wheel', 5, 1));

    expect(scrolled?.render).toBe(false);
  });
});
