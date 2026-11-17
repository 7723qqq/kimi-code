import { describe, expect, it } from 'bun:test';

import { KnowledgeInjection } from '#/agent/knowledge/knowledgeInjection';
import type {
  IAgentKnowledgeService,
  KnowledgeEntry,
  KnowledgeSearchResult,
} from '#/agent/knowledge/knowledge';
import type { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { IAgentReminderService } from '#/features/reminder/reminderService';
import type { ContextInjectionProvider } from '#/features/reminder/types';

type SearchCall = {
  readonly query: string;
  readonly scopePath: string | undefined;
  readonly tags: readonly string[];
};

function entry(title: string): KnowledgeEntry {
  return {
    id: title,
    category: 'coding-style',
    title,
    content: `${title} body`,
    tags: [],
    scope: null,
    confidence: 1,
    source: 'human',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function harness(text: string): {
  readonly inject: () => string | undefined;
  readonly calls: SearchCall[];
  readonly dispose: () => void;
} {
  const calls: SearchCall[] = [];
  const knowledge = {
    search(query: string, scopePath?: string, tags?: string[]) {
      calls.push({ query, scopePath, tags: tags ?? [] });
      const result: KnowledgeSearchResult = { entry: entry('lint'), relevance: 1, match_source: [] };
      return [result];
    },
  } as unknown as IAgentKnowledgeService;
  let provider: ContextInjectionProvider | undefined;
  const reminders = {
    register(_id: string, registered: ContextInjectionProvider) {
      provider = registered;
      return { dispose() {} };
    },
  } as unknown as IAgentReminderService;
  const messages: ContextMessage[] = [
    { role: 'user', content: [{ type: 'text', text }], toolCalls: [] },
  ];
  const contextMemory = {
    get: () => messages,
  } as unknown as IAgentContextMemoryService;

  const injection = new KnowledgeInjection(knowledge, reminders, contextMemory);

  return {
    calls,
    dispose: () => {
      injection.dispose();
    },
    inject: () => {
      const result = provider?.({ injectedPositions: [], lastInjectedAt: null, isNewTurn: true });
      return typeof result === 'string' ? result : undefined;
    },
  };
}

describe('knowledge injection signal extraction', () => {
  it('scopes the search to a path named in the prompt', () => {
    const test = harness('please review packages/agent-core-v2/src/index.ts');
    expect(test.inject()).toContain('1. [coding-style] lint');
    expect(test.calls[0]?.scopePath).toBe('packages/agent-core-v2/src/index.ts');
  });

  it('keeps the path when trailing punctuation follows it', () => {
    const test = harness('see `src/app/bootstrap.ts`.');
    test.inject();
    expect(test.calls[0]?.scopePath).toBe('src/app/bootstrap.ts');
  });

  it('does not treat a bare extension as a path', () => {
    const test = harness('which files end with .ts here');
    test.inject();
    expect(test.calls[0]?.scopePath).toBeUndefined();
  });

  it('reports no scope for prose without a file name', () => {
    const test = harness('explain the retry policy');
    test.inject();
    expect(test.calls[0]?.scopePath).toBeUndefined();
    expect(test.calls[0]?.query).toBe('explain the retry policy');
  });

  it('reports the first path when several appear', () => {
    const test = harness('a.ts and b.md');
    test.inject();
    expect(test.calls[0]?.scopePath).toBe('a.ts');
  });

  it('scans a large prompt in linear time', () => {
    const startedAt = performance.now();
    const test = harness(`${'x'.repeat(400_000)} src/main.ts`);
    test.inject();
    const elapsed = performance.now() - startedAt;
    expect(test.calls[0]?.scopePath).toBe('src/main.ts');
    expect(elapsed).toBeLessThan(250);
  });

  it('scans a dot-dense prompt in linear time', () => {
    const startedAt = performance.now();
    const test = harness('a.'.repeat(200_000));
    test.inject();
    expect(performance.now() - startedAt).toBeLessThan(250);
  });
});
