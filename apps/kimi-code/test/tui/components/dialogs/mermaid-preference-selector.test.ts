import { describe, expect, it, vi } from 'vitest';

import { MermaidPreferenceSelectorComponent } from '#/tui/components/dialogs/mermaid-preference-selector';
import { SettingsSelectorComponent } from '#/tui/components/dialogs/settings-selector';

// The real `t` goes through the native Rust engine, which is not loaded in
// tests, so it would hand back raw keys. Stub the strings this file asserts on.
vi.mock('#/i18n', () => ({
  t: (key: string) =>
    (
      {
        'tui.dialogs.mermaidPreferenceSelector.title': 'Mermaid diagrams',
        'tui.dialogs.mermaidPreferenceSelector.on': 'On',
        'tui.dialogs.mermaidPreferenceSelector.off': 'Off',
        'tui.dialogs.mermaidPreferenceSelector.onDescription':
          'Draw mermaid code blocks as diagrams in the terminal.',
        'tui.dialogs.mermaidPreferenceSelector.offDescription':
          'Keep mermaid code blocks as highlighted source.',
        'tui.dialogs.settingsSelector.theme': 'Theme',
        'tui.dialogs.settingsSelector.mermaid': 'Mermaid diagrams',
        'tui.dialogs.settingsSelector.editor': 'Editor',
        'tui.labels.current': '← current',
      } as Record<string, string>
    )[key] ?? key,
  setLocale: vi.fn(),
  getLocale: () => 'en',
}));

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

describe('MermaidPreferenceSelectorComponent', () => {
  it('maps the current preference onto the picker options with the current marker', () => {
    const selected: boolean[] = [];
    const enabledPicker = new MermaidPreferenceSelectorComponent({
      currentValue: true,
      onSelect: (value) => selected.push(value),
      onCancel: () => {},
    });
    const disabledPicker = new MermaidPreferenceSelectorComponent({
      currentValue: false,
      onSelect: (value) => selected.push(value),
      onCancel: () => {},
    });

    const enabledText = strip(enabledPicker.render(60).join('\n'));
    expect(enabledText).toContain('Mermaid diagrams');
    expect(enabledText).toContain('Draw mermaid code blocks as diagrams in the terminal.');
    expect(enabledText).toContain('Keep mermaid code blocks as highlighted source.');
    expect(enabledText).toContain('On ← current');
    expect(enabledText).not.toContain('final');

    const disabledText = strip(disabledPicker.render(60).join('\n'));
    expect(disabledText).toContain('Off ← current');

    enabledPicker.handleInput('\r');
    expect(selected).toEqual([true]);
    disabledPicker.handleInput('\r');
    expect(selected).toEqual([true, false]);
  });
});

describe('SettingsSelectorComponent mermaid entry', () => {
  it('offers Mermaid diagrams right after Theme', () => {
    const picker = new SettingsSelectorComponent({ onSelect: () => {}, onCancel: () => {} });
    const text = strip(picker.render(60).join('\n'));

    const themeIndex = text.indexOf('Theme');
    const mermaidIndex = text.indexOf('Mermaid diagrams');
    const editorIndex = text.indexOf('Editor');
    expect(mermaidIndex).toBeGreaterThan(themeIndex);
    expect(mermaidIndex).toBeLessThan(editorIndex);
  });
});
