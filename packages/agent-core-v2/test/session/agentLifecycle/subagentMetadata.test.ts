/**
 * Scenario: subagent delegation-depth accounting.
 *
 * The depth label round-trips through `subagentLabels` / `subagentDepthOf`,
 * absence and malformed values read as top-level depth zero, and the
 * ceiling is enforced by the `MAX_SUBAGENT_DEPTH` constant.
 */

import { describe, expect, it } from 'vitest';

import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import {
  MAX_SUBAGENT_DEPTH,
  subagentDepthOf,
  subagentLabels,
} from '#/session/agentLifecycle/subagentMetadata';

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
    // A chain of MAX_SUBAGENT_DEPTH spawns is legal...
    expect(subagentDepthOf(metaWith({ subagentDepth: String(MAX_SUBAGENT_DEPTH - 1) }))).toBe(
      MAX_SUBAGENT_DEPTH - 1,
    );
    // ...and one at the cap would already be rejected by the spawn guard.
    expect(subagentDepthOf(metaWith({ subagentDepth: String(MAX_SUBAGENT_DEPTH) }))).toBe(
      MAX_SUBAGENT_DEPTH,
    );
  });
});
