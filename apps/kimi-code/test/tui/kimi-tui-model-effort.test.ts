import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EffortSelectorComponent } from '#/tui/components/dialogs/effort-selector';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';

import { makeDriver, makeSession, renderTranscript } from './kimi-tui-message-flow-helpers';

describe('/model status displayName override', () => {
  it('shows the overridden display name in the switch status', async () => {
    const session = makeSession();
    const setConfig = vi.fn(async () => ({ providers: {} }));
    const { driver } = await makeDriver(session, {
      getConfig: vi.fn(async () => ({
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'kimi-k2',
            maxContextSize: 100,
            displayName: 'Kimi K2',
            capabilities: ['thinking'],
          },
          turbo: {
            provider: 'managed:kimi-code',
            model: 'kimi-turbo',
            maxContextSize: 100,
            displayName: 'Remote Turbo',
            capabilities: ['thinking'],
            overrides: { displayName: 'Custom Turbo' },
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: false },
      })),
      setConfig,
    });

    driver.handleUserInput('/model turbo');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(TabbedModelSelectorComponent);
    });
    (driver.state.editorContainer.children[0] as TabbedModelSelectorComponent).handleInput('\r');

    await vi.waitFor(() => {
      expect(setConfig).toHaveBeenCalledWith({
        defaultModel: 'turbo',
        thinking: { enabled: true },
      });
    });

    expect(renderTranscript(driver)).toContain('Switched to Custom Turbo with thinking on.');
    expect(renderTranscript(driver)).not.toContain('Remote Turbo');
  });
});

describe('/effort support_efforts override', () => {
  it('warns and applies efforts hidden by an Anthropic support_efforts override', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session, {
      getConfig: vi.fn(async () => ({
        providers: {
          compatible: { type: 'kimi', apiKey: 'test-key' },
        },
        models: {
          k2: {
            provider: 'compatible',
            model: 'compatible-model',
            protocol: 'anthropic',
            maxContextSize: 100,
            displayName: 'Compatible Model',
            capabilities: ['thinking'],
            supportEfforts: ['low', 'high', 'max'],
            overrides: { supportEfforts: ['low', 'high'] },
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: true, effort: 'low' },
      })),
    });

    driver.handleUserInput('/effort max');

    await vi.waitFor(() => {
      expect(session.setThinking).toHaveBeenCalledWith('max');
    });
    await vi.waitFor(() => {
      expect(renderTranscript(driver)).toContain('Thinking set to max.');
    });
    const transcript = renderTranscript(driver).replaceAll(/\s+/g, ' ');
    expect(transcript).toContain(
      'Thinking effort "max" is not listed for k2 (known: low, high). Sending "max" unchanged; the configured provider will validate it.',
    );
    expect(transcript).toContain('Thinking set to max.');
  });

  it('offers the latest Opus efforts for an unknown Claude-marked Anthropic-compatible model', async () => {
    const { driver } = await makeDriver(makeSession(), {
      getConfig: vi.fn(async () => ({
        providers: {
          compatible: { type: 'anthropic', apiKey: 'test-key' },
        },
        models: {
          k2: {
            provider: 'compatible',
            model: 'compatible-claude-model',
            maxContextSize: 100,
          },
        },
        defaultModel: 'k2',
      })),
    });

    driver.handleUserInput('/effort');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(EffortSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0] as EffortSelectorComponent;
    expect(picker.render(80).join('\n')).toContain('Max');
  });

  it('offers no fallback efforts for a clearly non-Claude Anthropic-compatible model', async () => {
    const { driver } = await makeDriver(makeSession(), {
      getConfig: vi.fn(async () => ({
        providers: {
          compatible: { type: 'anthropic', apiKey: 'test-key' },
        },
        models: {
          k2: {
            provider: 'compatible',
            model: 'compatible-model',
            maxContextSize: 100,
          },
        },
        defaultModel: 'k2',
      })),
    });

    driver.handleUserInput('/effort');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(EffortSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0] as EffortSelectorComponent;
    expect(picker.render(80).join('\n')).not.toContain('Max');
  });

  it('offers no fallback efforts for an unknown model on a Kimi provider using the Anthropic protocol', async () => {
    const { driver } = await makeDriver(makeSession(), {
      getConfig: vi.fn(async () => ({
        providers: {
          compatible: { type: 'kimi', apiKey: 'test-key' },
        },
        models: {
          k2: {
            provider: 'compatible',
            model: 'compatible-model',
            protocol: 'anthropic',
            maxContextSize: 100,
          },
        },
        defaultModel: 'k2',
      })),
    });

    driver.handleUserInput('/effort');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(EffortSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0] as EffortSelectorComponent;
    expect(picker.render(80).join('\n')).not.toContain('Max');
  });

  it('offers the latest Opus efforts for a flat providerless Claude-marked Anthropic model', async () => {
    const { driver } = await makeDriver(makeSession(), {
      getConfig: vi.fn(async () => ({
        providers: {},
        models: {
          k2: {
            model: 'compatible-claude-model',
            baseUrl: 'https://anthropic.example.test',
            protocol: 'anthropic',
            maxContextSize: 100,
          },
        },
        defaultModel: 'k2',
      })),
    });

    driver.handleUserInput('/effort');

    await vi.waitFor(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(EffortSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0] as EffortSelectorComponent;
    expect(picker.render(80).join('\n')).toContain('Max');
  });

  it('keeps rejecting efforts hidden by a Kimi support_efforts override', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session, {
      getConfig: vi.fn(async () => ({
        providers: {
          kimi: { type: 'kimi', apiKey: 'test-key' },
        },
        models: {
          k2: {
            provider: 'kimi',
            model: 'kimi-model',
            maxContextSize: 100,
            capabilities: ['thinking'],
            supportEfforts: ['low', 'high'],
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: true, effort: 'low' },
      })),
    });

    driver.handleUserInput('/effort max');

    await vi.waitFor(() => {
      expect(renderTranscript(driver)).toContain(
        'Unsupported thinking effort "max" for k2. Available: off, low, high',
      );
    });
    expect(session.setThinking).not.toHaveBeenCalled();
  });
});
