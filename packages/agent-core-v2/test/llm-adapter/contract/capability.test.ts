import { describe, expect, it } from 'bun:test';

import {
  UNKNOWN_CAPABILITY,
  isUnknownCapability,
  markUnknownCapability,
  toLlmCapability,
} from '#/llm-adapter/contract/capability';

const BLANK = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: false,
  max_context_tokens: 0,
  dynamically_loaded_tools: false,
} as const;

describe('isUnknownCapability', () => {
  it('reports an all-false capability with no context window as unknown', () => {
    expect(isUnknownCapability({ ...BLANK })).toBe(true);
  });

  it('reports a model that declares only pdf_in as known', () => {
    expect(isUnknownCapability({ ...BLANK, pdf_in: true })).toBe(false);
  });

  it('still reports any other single declaration as known', () => {
    expect(isUnknownCapability({ ...BLANK, image_in: true })).toBe(false);
    expect(isUnknownCapability({ ...BLANK, audio_in: true })).toBe(false);
    expect(isUnknownCapability({ ...BLANK, tool_use: true })).toBe(false);
    expect(isUnknownCapability({ ...BLANK, max_context_tokens: 1 })).toBe(false);
  });

  it('keeps the marker authoritative, including after marking', () => {
    expect(isUnknownCapability(UNKNOWN_CAPABILITY)).toBe(true);
    expect(isUnknownCapability(markUnknownCapability({ ...BLANK, image_in: true }))).toBe(true);
  });
});

describe('toLlmCapability', () => {
  it('carries pdf_in through, and leaves it absent when undeclared', () => {
    expect(toLlmCapability({ ...BLANK, pdf_in: true }).pdf_in).toBe(true);
    expect(toLlmCapability({ ...BLANK }).pdf_in).toBeUndefined();
  });
});
