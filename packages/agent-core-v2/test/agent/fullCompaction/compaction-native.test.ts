import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { estimateTokensForMessage } from '#/kosong/contract/tokens';
import {
  DEFAULT_COMPACTION_CONFIG,
  DefaultCompactionStrategy,
} from '#/agent/fullCompaction/strategy';
import { selectCompactionUserMessages } from '#/agent/contextMemory/compactionHandoff';
import type { Message } from '#/kosong/contract/message';

const mocks = vi.hoisted(() => ({
  tryNativeComputeCompactCount: vi.fn(),
  tryNativeCanSplitAfter: vi.fn(),
  tryNativeReduceCompactOnOverflow: vi.fn(),
  tryNativeSelectCompactionUserMessages: vi.fn(),
}));

vi.mock('#/_base/native-tools', () => mocks);

function textMessage(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }], toolCalls: [] };
}

function strategy(): DefaultCompactionStrategy {
  return new DefaultCompactionStrategy(() => 1_000, {
    triggerRatio: 0.85,
    blockRatio: 0.85,
    reservedContextSize: 0,
    maxCompactionPerTurn: 3,
    maxOverflowCompactionAttempts: 3,
    maxRecentMessages: 10,
    maxRecentUserMessages: Infinity,
    maxRecentSizeRatio: 0.2,
    minOverflowReductionRatio: 0.05,
  });
}

const basicMessages: readonly Message[] = [
  textMessage('user', 'old user'),
  textMessage('assistant', 'old assistant'),
  textMessage('user', 'recent user'),
  textMessage('assistant', 'recent assistant'),
];

describe('compaction native fast path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryNativeComputeCompactCount.mockReset();
    mocks.tryNativeCanSplitAfter.mockReset();
    mocks.tryNativeReduceCompactOnOverflow.mockReset();
    mocks.tryNativeSelectCompactionUserMessages.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes computeCompactCount through the native engine with projected metadata', () => {
    mocks.tryNativeComputeCompactCount.mockReturnValue(2);
    const result = strategy().computeCompactCount(basicMessages, 'auto');

    expect(result).toBe(2);
    expect(mocks.tryNativeComputeCompactCount).toHaveBeenCalledTimes(1);
    const [meta, config, isManual] = mocks.tryNativeComputeCompactCount.mock.calls[0]!;
    expect(meta).toHaveLength(4);
    expect(meta[0]).toEqual({
      role: 'user',
      toolCallsCount: 0,
      tokens: estimateTokensForMessage(basicMessages[0]!),
    });
    expect(config).toMatchObject({
      maxSize: 1_000,
      maxRecentMessages: 10,
      maxRecentSizeRatio: 0.2,
      minOverflowReductionRatio: 0.05,
    });
    expect(isManual).toBe(false);
  });

  it('marks manual compaction as manual and clamps Infinity user-message limits', () => {
    mocks.tryNativeComputeCompactCount.mockReturnValue(3);
    strategy().computeCompactCount(basicMessages, 'manual');

    const [meta, config, isManual] = mocks.tryNativeComputeCompactCount.mock.calls[0]!;
    expect(isManual).toBe(true);
    // Infinity (no limit) must not overflow the native u32 wire into 0.
    expect(config.maxRecentUserMessages).toBe(0xffffffff);
  });

  it('falls back to the TS algorithm when the native engine is unavailable', () => {
    mocks.tryNativeComputeCompactCount.mockReturnValue(undefined);
    mocks.tryNativeCanSplitAfter.mockReturnValue(undefined);
    const result = strategy().computeCompactCount(basicMessages, 'auto');

    // TS: compact prefix [user, assistant] → 2.
    expect(result).toBe(2);
  });

  it('routes reduceCompactOnOverflow through the native engine', () => {
    mocks.tryNativeReduceCompactOnOverflow.mockReturnValue(3);
    const result = strategy().reduceCompactOnOverflow(basicMessages);

    expect(result).toBe(3);
    expect(mocks.tryNativeReduceCompactOnOverflow).toHaveBeenCalledTimes(1);
    const [meta, config] = mocks.tryNativeReduceCompactOnOverflow.mock.calls[0]!;
    expect(meta).toHaveLength(4);
    expect(config.maxSize).toBe(1_000);
  });

  it('falls back to the TS algorithm for overflow reduction when unavailable', () => {
    mocks.tryNativeReduceCompactOnOverflow.mockReturnValue(undefined);
    mocks.tryNativeCanSplitAfter.mockReturnValue(undefined);
    const result = strategy().reduceCompactOnOverflow(basicMessages);

    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(basicMessages.length);
  });

  it('routes selectCompactionUserMessages through the native engine', () => {
    const userMessages = [textMessage('user', 'a'), textMessage('user', 'b')];
    mocks.tryNativeSelectCompactionUserMessages.mockReturnValue({
      headIndices: [],
      tailIndices: [0, 1],
      headTruncateChars: null,
      tailTruncateChars: null,
      elided: false,
      omittedTokens: 0,
    });

    const result = selectCompactionUserMessages(userMessages, 100, 20);

    expect(result.elided).toBe(false);
    expect(result.head).toEqual([]);
    expect(result.tail).toEqual(userMessages);
    expect(mocks.tryNativeSelectCompactionUserMessages).toHaveBeenCalledTimes(1);
    const [meta, maxTokens, headTokens] = mocks.tryNativeSelectCompactionUserMessages.mock.calls[0]!;
    expect(meta).toHaveLength(2);
    expect(meta[0]).toEqual({ role: 'user', text: 'a', tokens: estimateTokensForMessage(userMessages[0]!) });
    expect(maxTokens).toBe(100);
    expect(headTokens).toBe(20);
  });

  it('rebuilds truncated boundary messages from native byte counts', () => {
    const userMessages = [textMessage('user', '一'.repeat(300)), textMessage('user', '二'.repeat(300))];
    const fullHead = '一'.repeat(300);
    const headKept = Buffer.from(fullHead, 'utf8').subarray(0, 90).toString('utf8');
    const fullTail = '二'.repeat(300);
    const tailKept = Buffer.from(fullTail, 'utf8').subarray(-90).toString('utf8');
    mocks.tryNativeSelectCompactionUserMessages.mockReturnValue({
      headIndices: [0],
      tailIndices: [1],
      headTruncateChars: Buffer.byteLength(headKept, 'utf8'),
      tailTruncateChars: Buffer.byteLength(tailKept, 'utf8'),
      elided: true,
      omittedTokens: 300,
    });

    const result = selectCompactionUserMessages(userMessages, 200, 50);

    expect(result.elided).toBe(true);
    expect(result.head[0]!.content[0]).toMatchObject({ type: 'text', text: headKept });
    expect(result.tail[0]!.content[0]).toMatchObject({ type: 'text', text: tailKept });
  });

  it('falls back to the TS algorithm when the native module is unavailable', () => {
    mocks.tryNativeSelectCompactionUserMessages.mockReturnValue(undefined);
    const userMessages = [
      textMessage('user', 'a'),
      textMessage('user', 'b'),
    ];

    const result = selectCompactionUserMessages(userMessages, 100, 20);

    expect(result.elided).toBe(false);
    expect(result.tail).toEqual(userMessages);
  });
});
