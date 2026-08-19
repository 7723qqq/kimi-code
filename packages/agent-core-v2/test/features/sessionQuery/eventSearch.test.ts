/**
 * Scenario: the `sessionQuery` capability — event filtering and full-text
 * search (stage B).
 *
 * Exercises the literal-text/metadata event filters, token-based ranking
 * with bounded snippets, cursor paging, and the wire-journal event index
 * (revision-keyed cache rebuild).
 */

import { describe, expect, it } from 'vitest';

import { SessionSearchCursor } from '#/features/sessionQuery/cursor';
import { SessionEventIndex } from '#/features/sessionQuery/eventIndex';
import type { SessionEventSearchDocument } from '#/features/sessionQuery/events';
import { wireRecordText } from '#/features/sessionQuery/eventText';
import {
  filterSessionEvents,
  searchEventDocuments,
  compileSessionTextFilter,
} from '#/features/sessionQuery/search';

function doc(
  seq: number,
  text: string,
  time = seq * 1000,
  type = 'context.append_message',
): SessionEventSearchDocument {
  return { sessionId: 's1', seq, type, time, text };
}

describe('filterSessionEvents', () => {
  const docs = [
    doc(0, 'the quick brown fox'),
    doc(1, 'jumps over the lazy dog'),
    doc(2, 'quick things happen fast'),
  ];

  it('ANDs clauses and ORs values within a clause', () => {
    const result = filterSessionEvents(docs, [
      { kind: 'text', text: 'quick' },
      { kind: 'type', values: ['context.append_message'] },
    ]);
    expect(result.map((d) => d.seq)).toEqual([0, 2]);
  });

  it('matches literal text case-insensitively with flexible whitespace', () => {
    const pattern = compileSessionTextFilter('QUICK   brown');
    expect(pattern.test('the quick brown fox')).toBe(true);
    expect(pattern.test('the quickbrown fox')).toBe(false);
    expect(pattern.test('nothing here')).toBe(false);
  });

  it('filters by seq and time ranges inclusively', () => {
    expect(filterSessionEvents(docs, [{ kind: 'seq', from: 1, to: 2 }]).map((d) => d.seq)).toEqual([
      1, 2,
    ]);
    expect(filterSessionEvents(docs, [{ kind: 'time', from: 1000 }]).map((d) => d.seq)).toEqual([
      1, 2,
    ]);
  });

  it('rejects regex injection in text filters', () => {
    const pattern = compileSessionTextFilter('a.*b');
    expect(pattern.test('axxxb')).toBe(false); // literal, not a wildcard
    expect(pattern.test('a.*b')).toBe(true);
  });
});

describe('searchEventDocuments', () => {
  const docs = [
    doc(0, 'refactor the token pipeline for speed'),
    doc(1, 'tokens are counted per request'),
    doc(2, 'unrelated note about caching'),
  ];

  it('ranks by exact token overlap and returns bounded snippets', () => {
    const { items } = searchEventDocuments(docs, 'token');
    // `tokens` is a distinct term; exact-token matching keeps it out.
    expect(items).toHaveLength(1);
    expect(items[0]?.snippet).toContain('token');
    expect(items[0]?.snippet.length).toBeLessThanOrEqual(2 * 40 + 10);
  });

  it('returns an empty page when nothing matches', () => {
    const { items, nextCursor } = searchEventDocuments(docs, 'zzz');
    expect(items).toEqual([]);
    expect(nextCursor).toBeUndefined();
  });

  it('pages through an opaque offset cursor', () => {
    const first = searchEventDocuments(docs, 'token', 1);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeUndefined();
  });

  it('applies metadata filters before ranking', () => {
    const { items } = searchEventDocuments(
      filterSessionEvents(docs, [{ kind: 'seq', from: 1 }]),
      'tokens',
    );
    expect(items.map((hit) => hit.seq)).toEqual([1]);
  });

  it('rejects an empty query', () => {
    expect(() => searchEventDocuments(docs, '   ')).toThrowError(/searchable text/);
  });
});

describe('wireRecordText', () => {
  it('joins textual payload fields in stable order', () => {
    expect(wireRecordText({ type: 'x', text: 'hello', output: 'world' })).toBe('hello\nworld');
  });

  it('extracts content-part text', () => {
    expect(
      wireRecordText({
        type: 'x',
        content: [{ type: 'text', text: 'part one' }, { type: 'other' }],
      }),
    ).toBe('part one');
  });

  it('contributes no text for empty records', () => {
    expect(wireRecordText({ type: 'x', time: 1 })).toBe('');
  });
});

describe('SessionEventIndex', () => {
  it('reads wire records into event documents with seq/time/type/text', async () => {
    const records = [
      { type: 'metadata', protocol_version: '1', created_at: 1 },
      {
        type: 'context.append_message',
        time: 100,
        message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
      },
      { type: 'llm.request', time: 200, prompt: 'analyze this' },
    ];
    const logStub = {
      revision: () => 7,
      read: () =>
        (async function* () {
          for (const record of records) yield record;
        })(),
    };
    const bootstrapStub = { scope: () => 'sessions' };
    const index = new SessionEventIndex(bootstrapStub as never, logStub as never, { size: () => 0 } as never);

    const events = await index.eventsOf('ws', 's1');
    expect(events).toHaveLength(2); // metadata skipped
    expect(events[0]).toMatchObject({ seq: 0, type: 'context.append_message', time: 100 });
    expect(events[0]?.text).toContain('hello world');
    expect(events[1]?.text).toContain('analyze this');
    expect(index.wireScopeOf('ws', 's1')).toBe('sessions/ws/s1/agents/main');
  });

  it('serves cached events while the journal revision is unchanged', async () => {
    let revision = 1;
    let reads = 0;
    const logStub = {
      revision: () => revision,
      read: () => {
        reads += 1;
        return (async function* () {
          yield { type: 'context.append_message', time: 1, text: 'first' };
        })();
      },
    };
    const bootstrapStub = { scope: () => 'sessions' };
    const storageStub = { size: () => revision };
    const index = new SessionEventIndex(bootstrapStub as never, logStub as never, storageStub as never);

    await index.eventsOf('ws', 's1');
    await index.eventsOf('ws', 's1');
    expect(reads).toBe(1);

    revision = 2;
    await index.eventsOf('ws', 's1');
    expect(reads).toBe(2);
  });

  it('invalidates a session cache on demand', async () => {
    let reads = 0;
    const logStub = {
      revision: () => 1,
      read: () => {
        reads += 1;
        return (async function* () {
          yield { type: 'x', time: 1, text: 't' };
        })();
      },
    };
    const bootstrapStub = { scope: () => 'sessions' };
    const index = new SessionEventIndex(bootstrapStub as never, logStub as never, { size: () => 0 } as never);
    await index.eventsOf('ws', 's1');
    index.invalidate('s1');
    await index.eventsOf('ws', 's1');
    expect(reads).toBe(2);
  });
});

describe('SessionSearchCursor', () => {
  it('carries an opaque offset', () => {
    const cursor = SessionSearchCursor(5);
    expect(cursor.offset).toBe(5);
  });
});
