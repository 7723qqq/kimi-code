import { describe, expect, it } from 'vitest';

import { DiscussionContext, type DiscussionEntry } from '../../../src/agent/discussion/context';

describe('DiscussionContext', () => {
  it('starts empty', () => {
    const ctx = new DiscussionContext();
    expect(ctx.isEmpty()).toBe(true);
    expect(ctx.getRound()).toBe(0);
    expect(ctx.lastSpeaker()).toBeNull();
    expect(ctx.latestEntry()).toBeNull();
    expect(ctx.entryCount()).toBe(0);
    expect(ctx.getTranscript()).toBe('');
    expect(ctx.allEntries()).toEqual([]);
  });

  it('adds entries and tracks round', () => {
    const ctx = new DiscussionContext();
    ctx.addEntry('researcher', 'agent-1', 'I propose using a connection pool.', 1);
    expect(ctx.isEmpty()).toBe(false);
    expect(ctx.getRound()).toBe(1);
    expect(ctx.lastSpeaker()).toBe('researcher');
    expect(ctx.latestEntry()).toEqual({
      speaker: 'researcher',
      agentId: 'agent-1',
      content: 'I propose using a connection pool.',
      round: 1,
    });
    expect(ctx.entryCount()).toBe(1);
  });

  it('increments round across multiple entries in the same round', () => {
    const ctx = new DiscussionContext();
    ctx.addEntry('alice', 'id-1', 'Hello', 1);
    ctx.addEntry('bob', 'id-2', 'Hi', 1);
    expect(ctx.getRound()).toBe(1);
    expect(ctx.entryCount()).toBe(2);
    expect(ctx.lastSpeaker()).toBe('bob');
  });

  it('tracks round changes across different rounds', () => {
    const ctx = new DiscussionContext();
    ctx.addEntry('alice', 'id-1', 'R1', 1);
    ctx.addEntry('bob', 'id-2', 'R2', 2);
    expect(ctx.getRound()).toBe(2);
    expect(ctx.entryCount()).toBe(2);
    expect(ctx.lastSpeaker()).toBe('bob');
  });

  it('renders transcript with speaker labels', () => {
    const ctx = new DiscussionContext();
    ctx.addEntry('researcher', 'id-1', 'Use connection pooling.', 1);
    ctx.addEntry('architect', 'id-2', 'Agreed. Set max connections.', 1);
    ctx.addEntry('engineer', 'id-3', 'Add a queue for overflow.', 2);

    expect(ctx.getTranscript()).toBe(
      '[researcher] Use connection pooling.\n\n[architect] Agreed. Set max connections.\n\n[engineer] Add a queue for overflow.',
    );
  });

  it('returns empty transcript for no entries', () => {
    const ctx = new DiscussionContext();
    expect(ctx.getTranscript()).toBe('');
  });

  it('allEntries returns a snapshot', () => {
    const ctx = new DiscussionContext();
    ctx.addEntry('a', 'id-1', 'x', 1);
    const entries = ctx.allEntries() as DiscussionEntry[];
    expect(entries).toHaveLength(1);
    // Mutating the returned array should not affect internal state
    entries.pop();
    expect(ctx.entryCount()).toBe(1);
  });
});