import { describe, expect, it } from 'bun:test';

import { ErrorCodes, isError2 } from '#/errors';
import {
  assertSubagentDepthAllowed,
  MAX_SUBAGENT_DEPTH,
  subagentDepthOf,
  subagentLabels,
} from '#/session/agentLifecycle/subagentMetadata';
import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';

function metaWith(labels: Record<string, string> | undefined): AgentMeta {
  return { labels } as AgentMeta;
}

describe('subagent delegation depth', () => {
  it('records the depth in the labels and reads it back', () => {
    const labels = subagentLabels('parent', { depth: 3 });
    expect(labels['subagentDepth']).toBe('3');
    expect(subagentDepthOf(metaWith(labels))).toBe(3);
  });

  it('omits the depth label when not requested', () => {
    const labels = subagentLabels('parent');
    expect(labels['subagentDepth']).toBeUndefined();
    expect(subagentDepthOf(metaWith(labels))).toBe(0);
  });

  it('treats missing metadata as top-level depth zero', () => {
    expect(subagentDepthOf(undefined)).toBe(0);
    expect(subagentDepthOf(metaWith(undefined))).toBe(0);
  });

  it('treats malformed depth values as depth zero', () => {
    expect(subagentDepthOf(metaWith({ subagentDepth: 'abc' }))).toBe(0);
    expect(subagentDepthOf(metaWith({ subagentDepth: '-1' }))).toBe(0);
    expect(subagentDepthOf(metaWith({ subagentDepth: '1.5' }))).toBe(1);
  });

  it('keeps a child below the ceiling and rejects at the cap', () => {
    expect(MAX_SUBAGENT_DEPTH).toBeGreaterThanOrEqual(4);
    expect(subagentDepthOf(metaWith({ subagentDepth: String(MAX_SUBAGENT_DEPTH - 1) }))).toBe(
      MAX_SUBAGENT_DEPTH - 1,
    );
    expect(subagentDepthOf(metaWith({ subagentDepth: String(MAX_SUBAGENT_DEPTH) }))).toBe(
      MAX_SUBAGENT_DEPTH,
    );
  });

  it('returns the child depth (caller + 1) for a caller below the ceiling', () => {
    expect(assertSubagentDepthAllowed(undefined)).toBe(1);
    expect(assertSubagentDepthAllowed(metaWith({ subagentDepth: '3' }))).toBe(4);
  });

  it('raises the depth one generation at a time from a missing meta up to the cap', () => {
    let meta: AgentMeta | undefined = undefined;
    for (let generation = 1; generation <= MAX_SUBAGENT_DEPTH; generation += 1) {
      const depth = assertSubagentDepthAllowed(meta);
      expect(depth).toBe(generation);
      meta = metaWith(subagentLabels('parent', { depth }));
      expect(subagentDepthOf(meta)).toBe(generation);
    }
    expect(subagentDepthOf(meta)).toBe(MAX_SUBAGENT_DEPTH);
  });

  it('throws SUBAGENT_DEPTH_EXCEEDED for a caller at the ceiling', () => {
    let thrown: unknown;
    try {
      assertSubagentDepthAllowed(metaWith({ subagentDepth: String(MAX_SUBAGENT_DEPTH) }));
    } catch (error) {
      thrown = error;
    }
    expect(isError2(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe(ErrorCodes.SUBAGENT_DEPTH_EXCEEDED);
    expect(String(thrown)).toMatch(/delegation depth exceeded/i);
    expect(() =>
      assertSubagentDepthAllowed(metaWith({ subagentDepth: String(MAX_SUBAGENT_DEPTH) })),
    ).toThrowError(/delegation depth exceeded/i);
  });
});
