import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentKnowledgeService } from '#/agent/knowledge/knowledge';
import { INJECTION_CONFIDENCE_FLOOR } from '#/agent/knowledge/knowledgeService';
import { LEARNED_CONFIDENCE } from '#/agent/knowledge/knowledgeLearner';

import { createTestAgent, type TestAgentContext } from '../../harness';

const nativeKnowledge = (() => {
  try {
    return require('@moonshot-ai/kimi-native-tools') as {
      knowledgeClose?: () => void;
    };
  } catch {
    return undefined;
  }
})();

describe('the learned-to-confirmed gate', () => {
  it('withholds a freshly learned entry', () => {
    expect(LEARNED_CONFIDENCE).toBeLessThan(INJECTION_CONFIDENCE_FLOOR);
  });

  it('admits a confirmed entry', () => {
    expect(1.0).toBeGreaterThanOrEqual(INJECTION_CONFIDENCE_FLOOR);
  });
});

describe('learning loop over the real native module', () => {
  let ctx: TestAgentContext;
  let knowledge: IAgentKnowledgeService;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-loop-'));
    process.env['KIMI_KNOWLEDGE_DB'] = join(dir, 'knowledge.db');
    ctx = createTestAgent({ autoConfigure: false });
    knowledge = ctx.get(IAgentKnowledgeService);
  });

  afterEach(async () => {
    await ctx.dispose();
    nativeKnowledge?.knowledgeClose?.();
    delete process.env['KIMI_KNOWLEDGE_DB'];
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores an entry and returns it without a status field', async () => {
    await ctx.restorePersisted();
    ctx.configure();

    const entry = knowledge.add({
      title: 'Prefer catalog: for shared ranges',
      category: 'coding-style',
      content: 'Repeat the range only when it differs from the catalog.',
      tags: ['deps'],
      source: 'ai-learned',
      confidence: LEARNED_CONFIDENCE,
    });

    expect(entry, 'knowledge.add returned null — is the native API wired?').not.toBeNull();
    expect(entry!.id.length).toBeGreaterThan(0);
    expect(entry).not.toHaveProperty('status');
    expect(entry!.confidence).toBe(LEARNED_CONFIDENCE);
  });

  it('does not inject a learned entry until it is confirmed', async () => {
    await ctx.restorePersisted();
    ctx.configure();

    const entry = knowledge.add({
      title: 'Always push after committing',
      category: 'workflow',
      content: 'Always push after committing, so CI sees the change.',
      tags: ['git'],
      source: 'ai-learned',
      confidence: LEARNED_CONFIDENCE,
    });
    expect(entry).not.toBeNull();

    const before = knowledge.search('push');
    expect(before.map((r) => r.entry.id)).not.toContain(entry!.id);

    expect(knowledge.confirm(entry!.id)).toBe(true);

    const after = knowledge.search('push');
    expect(after.map((r) => r.entry.id)).toContain(entry!.id);
    expect(after.every((r) => r.entry.confidence >= INJECTION_CONFIDENCE_FLOOR)).toBe(true);
  });

  it('reports stats that reflect a stored entry', async () => {
    await ctx.restorePersisted();
    ctx.configure();

    knowledge.add({
      title: 'Stat probe',
      category: 'pitfall',
      content: 'A pitfall worth recording.',
      tags: [],
      source: 'human',
      confidence: 1,
    });

    const stats = knowledge.stats();
    expect(stats.total).toBeGreaterThan(0);
    expect(stats).not.toHaveProperty('by_status');
  });
});
