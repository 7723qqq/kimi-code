/**
 * TUI2 compaction view tests.
 *
 * The transcript entry's `compactionData` drives the phase MainShell renders
 * (`compactionViewPropsFromData`): running (tip), complete (token delta),
 * cancelled — plus the custom instruction carried through every phase.
 */

import { describe, expect, it } from 'vitest'

import { compactionViewPropsFromData } from '@/tui2/components/dialogs/compaction'
import type { CompactionTranscriptData } from '@/tui2/types'

describe('compactionViewPropsFromData', () => {
  it('maps a running compaction to the tip phase', () => {
    const data: CompactionTranscriptData = { summary: 'fetching tips' };
    expect(compactionViewPropsFromData(data)).toEqual({
      tip: 'fetching tips',
      instruction: undefined,
    });
  });

  it('maps a finished compaction to the token-delta phase', () => {
    const data: CompactionTranscriptData = {
      tokensBefore: 150_000,
      tokensAfter: 32_000,
      summary: 'summary text',
      instruction: 'keep decisions',
    };
    expect(compactionViewPropsFromData(data)).toEqual({
      done: true,
      tokensBefore: 150_000,
      tokensAfter: 32_000,
      summary: 'summary text',
      instruction: 'keep decisions',
    });
  });

  it('treats a one-sided token count as done', () => {
    const data: CompactionTranscriptData = { tokensAfter: 10_000 };
    expect(compactionViewPropsFromData(data).done).toBe(true);
  });

  it('maps a cancelled compaction', () => {
    const data: CompactionTranscriptData = { result: 'cancelled' };
    expect(compactionViewPropsFromData(data)).toEqual({
      canceled: true,
      instruction: undefined,
    });
  });

  it('carries the instruction in every phase', () => {
    expect(
      compactionViewPropsFromData({ instruction: 'focus on code' }).instruction,
    ).toBe('focus on code');
    expect(
      compactionViewPropsFromData({ result: 'cancelled', instruction: 'x' }).instruction,
    ).toBe('x');
  });
});
