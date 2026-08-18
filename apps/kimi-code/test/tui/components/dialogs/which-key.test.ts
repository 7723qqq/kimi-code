import { describe, expect, it, vi } from 'vitest';

import { WhichKeyComponent } from '#/tui/components/dialogs/which-key';

// oxlint-disable-next-line no-control-regex -- ESC (\u001B) is required to match ANSI SGR escape sequences
const stripAnsi = (s: string): string => s.replaceAll(/\u001B\[[0-9;]*m/g, '');

describe('WhichKeyComponent', () => {
  it('renders the leader chords and shortcuts sections', () => {
    const component = new WhichKeyComponent();
    const plain = component.render(80).map(stripAnsi).join('\n');
    expect(plain).toContain('Leader');
    expect(plain).toContain('Ctrl-X e');
    expect(plain).toContain('Ctrl-X m');
    expect(plain).toContain('Ctrl-X h');
    expect(plain).toContain('Shortcuts');
    expect(plain).toContain('Ctrl-D');
  });

  it('closes on Esc when focusable', () => {
    const onClose = vi.fn();
    const component = new WhichKeyComponent({ onClose });
    component.handleInput('\x1b');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Enter when focusable', () => {
    const onClose = vi.fn();
    const component = new WhichKeyComponent({ onClose });
    component.handleInput('\r');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on q when focusable', () => {
    const onClose = vi.fn();
    const component = new WhichKeyComponent({ onClose });
    component.handleInput('q');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not close when non-focusable (leader overlay)', () => {
    const onClose = vi.fn();
    const component = new WhichKeyComponent({ onClose, focusable: false });
    component.handleInput('\x1b');
    component.handleInput('\r');
    component.handleInput('q');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('WhichKeyComponent search palette', () => {
  it('filters entries by query', () => {
    const component = new WhichKeyComponent({});
    for (const ch of 'model') component.handleInput(ch);
    const out = component.render(80).join('\n');
    expect(out).toContain('Select model');
    expect(out).not.toContain('New session');
  });

  it('executes the selected command on Enter', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const component = new WhichKeyComponent({ onSelect, onClose });
    for (const ch of 'model') component.handleInput(ch);
    component.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('model');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('moves the selection with arrow keys', () => {
    const onSelect = vi.fn();
    const component = new WhichKeyComponent({ onSelect });
    component.handleInput('\x1b[B'); // down
    component.handleInput('\r');
    expect(onSelect).toHaveBeenCalled();
  });

  it('clears the query with backspace', () => {
    const component = new WhichKeyComponent({});
    component.handleInput('m');
    component.handleInput('\x7f'); // backspace
    const out = component.render(80).join('\n');
    expect(out).toContain('New session');
  });
});
