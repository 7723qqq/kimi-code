import type { ExperimentalFeatureState } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, mock } from 'bun:test';

import {
  ExperimentsSelectorComponent,
  type ExperimentalFeatureDraftChange,
} from '#/tui/components/dialogs/experiments-selector';


const ANSI = /\u001B\[[0-9;]*m/g;
const ESC = String.fromCodePoint(27);
const ENTER = '\r';

function strip(text: string): string {
  return text.replaceAll(ANSI, '');
}

function feature(
  overrides: Partial<ExperimentalFeatureState> = {},
): ExperimentalFeatureState {
  return {
    id: 'micro_compaction',
    title: 'Micro compaction',
    description: 'Trim older tool results.',
    surface: 'core',
    env: 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION',
    defaultEnabled: true,
    enabled: true,
    source: 'default',
    ...overrides,
  };
}

function text(component: ExperimentsSelectorComponent, width = 120): string {
  return component.render(width).map(strip).join('\n');
}

describe('ExperimentsSelectorComponent', () => {
  it('renders searchable feature toggles with source details', () => {
    const selector = new ExperimentsSelectorComponent({
      features: [
        feature({ enabled: true, source: 'config', configValue: true }),
      ],
      onApply: mock(),
      onCancel: mock(),
    });

    const out = text(selector);

    expect(out).toContain(' Experimental features  (type to search)');
    expect(out).toContain(' ↑↓ navigate · Space toggle · Enter apply · Esc cancel');
    expect(out).toContain('  ❯ Micro compaction (cache-miss tool-result truncation)  enabled');
    expect(out).toContain('    id micro_compaction · config · KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION');
    expect(out).toContain('    After a prompt-cache miss');
    expect(out).toContain(' [ Apply changes and reload ]  no changes');
  });

  it('drafts changes with Space and applies them with Enter', () => {
    const onApply = mock<(changes: readonly ExperimentalFeatureDraftChange[]) => void>();
    const first = feature();
    const selector = new ExperimentsSelectorComponent({
      features: [first],
      onApply,
      onCancel: mock(),
    });

    selector.handleInput(' ');

    expect(onApply).not.toHaveBeenCalled();
    expect(text(selector)).toContain('  ❯ Micro compaction (cache-miss tool-result truncation)  disabled');
    expect(text(selector)).toContain(
      '    id micro_compaction · default · KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION · modified',
    );
    expect(text(selector)).toContain(' [ Apply changes and reload ]  1 change');

    selector.handleInput(ENTER);

    expect(onApply).toHaveBeenCalledWith([
      { id: 'micro_compaction', enabled: false },
    ]);
  });

  it('does not draft changes for env-locked features', () => {
    const onApply = mock<(changes: readonly ExperimentalFeatureDraftChange[]) => void>();
    const selector = new ExperimentsSelectorComponent({
      features: [
        feature({
          enabled: true,
          source: 'env',
        }),
      ],
      onApply,
      onCancel: mock(),
    });

    selector.handleInput(' ');
    selector.handleInput(ENTER);

    expect(text(selector)).toContain('  ❯ Micro compaction (cache-miss tool-result truncation)  enabled');
    expect(text(selector)).toContain(' [ Apply changes and reload ]  no changes');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('treats a space as part of the query once searching has started', () => {
    const onApply = mock<(changes: readonly ExperimentalFeatureDraftChange[]) => void>();
    const selector = new ExperimentsSelectorComponent({
      features: [feature()],
      onApply,
      onCancel: mock(),
    });

    for (const char of 'web search') selector.handleInput(char);

    // The space belongs to the query, so no draft was flipped on the way.
    expect(text(selector)).toContain('Search: web search');
    expect(text(selector)).toContain(' [ Apply changes and reload ]  no changes');
    expect(text(selector)).not.toContain('modified');

    selector.handleInput(ENTER);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('still toggles with a space while the query is empty', () => {
    // The single-key toggle keeps working where it is unambiguous: nothing has
    // been typed yet, so the space cannot belong to a search.
    const selector = new ExperimentsSelectorComponent({
      features: [feature()],
      onApply: mock(),
      onCancel: mock(),
    });

    selector.handleInput(' ');

    expect(text(selector)).toContain('  ❯ Micro compaction (cache-miss tool-result truncation)  disabled');
  });

  it('filters by typing and clears the query before cancelling', () => {
    const onCancel = mock();
    const selector = new ExperimentsSelectorComponent({
      features: [feature()],
      onApply: mock(),
      onCancel,
    });

    selector.handleInput('m');
    selector.handleInput('i');
    selector.handleInput('c');
    expect(text(selector)).toContain('Search: mic');
    expect(text(selector)).toContain('Micro compaction');

    selector.handleInput(ESC);
    expect(onCancel).not.toHaveBeenCalled();
    selector.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
