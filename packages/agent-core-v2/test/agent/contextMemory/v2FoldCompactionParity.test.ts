import { describe, expect, it } from 'vitest';

import { buildCompactionContinuationText } from '#/agent/contextMemory/compactionHandoff';
import { foldV2WireRecords } from '#human/persist/v2/fold';
import type { V2WireRecord } from '#human/persist/v2/wire';

function appendUser(text: string): V2WireRecord {
  return {
    type: 'context.append_message',
    agentId: 'main',
    time: 1,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'user' },
    },
  };
}

function compaction(summary: string, compactedCount: number): V2WireRecord {
  return {
    type: 'context.apply_compaction',
    agentId: 'main',
    time: 1,
    summary,
    contextSummary: `CTX-${summary}`,
    compactedCount,
    keptUserMessageCount: 1,
  };
}

describe('v2 fold compaction parity with the live reducer', () => {
  it('ends the modern shape with a byte-identical continuation message', () => {
    const folded = foldV2WireRecords([appendUser('u1'), appendUser('u2'), compaction('S', 2)]);
    const last = folded.messages.at(-1)!;
    const continuation = buildCompactionContinuationText();
    expect(last.content).toEqual([{ type: 'text', text: continuation }]);
    expect(last.origin).toEqual({ kind: 'injection', variant: 'compaction_continuation' });
    expect(last.role).toBe('user');
    expect(folded.messages.at(-2)?.origin).toEqual({ kind: 'compaction_summary' });
  });

  it('keeps the legacy shape free of a continuation message', () => {
    const legacy = foldV2WireRecords([
      appendUser('u1'),
      appendUser('u2'),
      appendUser('u3'),
      {
        type: 'context.apply_compaction',
        agentId: 'main',
        time: 1,
        summary: 'LEG',
        compactedCount: 2,
      },
    ]);
    expect(legacy.messages.map((message) => message.origin?.kind)).toEqual([
      'compaction_summary',
      'user',
    ]);
  });
});
