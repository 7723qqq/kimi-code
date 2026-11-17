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

  it('keeps the full extension of a tsx or jsx file', () => {
    const test = harness('src/app.tsx');
    test.inject();
    expect(test.calls[0]?.scopePath).toBe('src/app.tsx');
  });

  it('stops at the file name when a backup suffix follows it', () => {
    const test = harness('restore config.json.bak next');
    test.inject();
    expect(test.calls[0]?.scopePath).toBe('config.json');
  });

  it('does not read a file name out of the middle of a word', () => {
    const test = harness('ja.jss_');
    test.inject();
    expect(test.calls[0]?.scopePath).toBeUndefined();
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

  it('agrees with a straightforward scan on random text', () => {
    const extensions = ['tsx', 'ts', 'js', 'jsx', 'json', 'rs', 'vue', 'md'];
    const isWord = (ch: string | undefined): boolean => /^[A-Za-z0-9_]$/.test(ch ?? '');
    const isPath = (ch: string | undefined): boolean => /^[\w./\\-]$/.test(ch ?? '');
    const reference = (text: string): string | undefined => {
      let runStart = 0;
      for (let index = 0; index <= text.length; index += 1) {
        if (index < text.length && isPath(text[index])) continue;
        const run = text.slice(runStart, index);
        let best: number | undefined;
        for (let offset = 1; offset < run.length; offset += 1) {
          if (run[offset] !== '.') continue;
          for (const extension of extensions) {
            if (!run.startsWith(extension, offset + 1)) continue;
            const end = offset + 1 + extension.length;
            if (end !== run.length && isWord(run[end])) continue;
            best = end;
          }
        }
        if (best !== undefined) return run.slice(0, best);
        runStart = index + 1;
      }
      return undefined;
    };

    const alphabet = ['a', 't', 's', 'x', 'j', 'o', 'n', 'r', 'v', 'u', 'e', 'm', 'd', 'b'];
    const separators = ['.', '/', '\\', '-', '_', ' ', '1', '中'];
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    for (let round = 0; round < 400; round += 1) {
      const length = next() % 24;
      let text = '';
      for (let index = 0; index < length; index += 1) {
        const pool = next() % 3 === 0 ? separators : alphabet;
        text += pool[next() % pool.length];
      }
      const test = harness(text);
      test.inject();
      expect({ text, scopePath: test.calls[0]?.scopePath }).toEqual({
        text,
        scopePath: reference(text),
      });
    }
  });
});
