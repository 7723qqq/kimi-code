import { describe, expect, it } from 'vitest';

import { editorBorderHighlighted } from '#/tui/kimi-tui';

function state(overrides: Partial<Parameters<typeof editorBorderHighlighted>[0]> = {}) {
  return {
    planMode: false,
    specMode: false,
    swarmMode: false,
    towerMode: false,
    inputMode: 'prompt' as const,
    ...overrides,
  };
}

describe('editorBorderHighlighted', () => {
  it('highlights in plan mode', () => {
    expect(editorBorderHighlighted(state({ planMode: true }), false, '')).toBe(true);
  });

  it('highlights in spec mode', () => {
    expect(editorBorderHighlighted(state({ specMode: true }), false, '')).toBe(true);
  });

  it('highlights in swarm mode', () => {
    expect(editorBorderHighlighted(state({ swarmMode: true }), false, '')).toBe(true);
  });

  it('highlights in tower mode', () => {
    expect(editorBorderHighlighted(state({ towerMode: true }), false, '')).toBe(true);
  });

  it('stays plain with no mode, no bash, and no slash', () => {
    expect(editorBorderHighlighted(state(), false, 'hello')).toBe(false);
  });

  it('still highlights bash mode and slash input', () => {
    expect(editorBorderHighlighted(state(), true, '')).toBe(true);
    expect(editorBorderHighlighted(state(), false, '/spec')).toBe(true);
  });
});
