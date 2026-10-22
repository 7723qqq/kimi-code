import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { applyMermaidPreferenceChoice } from '#/tui/commands/config';
import * as tuiConfig from '#/tui/config';
import { darkColors } from '#/tui/theme/colors';
import { getMarkdownMermaidMode, setMarkdownMermaidMode } from '#/tui/utils/markdown-options';

const mocks = {
  saveTuiConfig: spyOn(tuiConfig, 'saveTuiConfig').mockImplementation(async () => {}),
};

function makeHost(mermaid: 'off' | 'final') {
  return {
    state: {
      appState: {
        theme: 'auto' as const,
        editorCommand: null,
        notifications: { enabled: true, condition: 'unfocused' as const },
        upgrade: { autoInstall: true },
        markdown: { mermaid },
      },
      theme: { palette: darkColors },
      transcriptContainer: { invalidate: mock() },
      ui: { requestRender: mock() },
    },
    setAppState: mock(),
    showStatus: mock(),
  };
}

afterEach(() => {
  setMarkdownMermaidMode('final');
});

describe('mermaid preference commands', () => {
  it('saves off to tui.toml, mirrors appState, updates the live mode, and redraws the transcript', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost('final');

    await applyMermaidPreferenceChoice(host, false);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: { mermaid: 'off' } }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ markdown: { mermaid: 'off' } });
    expect(getMarkdownMermaidMode()).toBe('off');
    expect(host.state.transcriptContainer.invalidate).toHaveBeenCalled();
    expect(host.state.ui.requestRender).toHaveBeenCalledWith(true);
    expect(host.showStatus).toHaveBeenCalledWith('Mermaid diagrams disabled.');
  });

  it('re-enables diagrams from an off state', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost('off');

    await applyMermaidPreferenceChoice(host, true);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: { mermaid: 'final' } }),
    );
    expect(getMarkdownMermaidMode()).toBe('final');
    expect(host.showStatus).toHaveBeenCalledWith('Mermaid diagrams enabled.');
  });

  it('does not rewrite the config or redraw when the value is unchanged', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost('final');

    await applyMermaidPreferenceChoice(host, true);

    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.state.transcriptContainer.invalidate).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Mermaid diagrams already enabled.');
  });

  it('reports a save failure without touching appState or the live mode', async () => {
    mocks.saveTuiConfig.mockRejectedValueOnce(new Error('disk full'));
    const host = makeHost('final');

    await applyMermaidPreferenceChoice(host, false);

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(getMarkdownMermaidMode()).toBe('final');
    expect(host.state.transcriptContainer.invalidate).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Failed to save mermaid diagram setting: disk full',
      'error',
    );
  });
});
