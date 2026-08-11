import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { setLocale } from '@moonshot-ai/kimi-i18n';

import type { TokenUsage } from '#/kosong/contract/usage';
import type {
  PersistentSubagentHost,
  PersistentSubagentSpawnOptions,
} from '#/session/subagent/persistentSubagent';
import { SwarmDiscussionCoordinator } from '#/agent/discussion/coordinator';
import { StructuredDebateCoordinator } from '#/agent/discussion/debate-coordinator';
import { DiscussionContext } from '#/agent/discussion/context';

interface StubHostState {
  readonly host: PersistentSubagentHost;
  readonly spawned: PersistentSubagentSpawnOptions[];
  readonly turns: Array<{ readonly agentId: string; readonly prompt: string }>;
  readonly destroyed: string[];
  readonly spawnPersistent: Mock;
  readonly runDiscussionTurn: Mock;
  readonly getPersistentUsage: Mock;
  readonly destroyPersistent: Mock;
}

function createStubHost(
  options: {
    readonly replies?: readonly string[];
    readonly usages?: Readonly<Record<string, TokenUsage>>;
    readonly throwOnTurn?: (index: number) => Error | undefined;
    readonly onTurn?: (index: number) => void;
  } = {},
): StubHostState {
  const spawned: PersistentSubagentSpawnOptions[] = [];
  const turns: Array<{ readonly agentId: string; readonly prompt: string }> = [];
  const destroyed: string[] = [];
  let nextId = 0;
  let turnIndex = 0;

  const spawnPersistent = vi.fn(async (spawnOptions: PersistentSubagentSpawnOptions) => {
    spawned.push(spawnOptions);
    return `agent-${String(nextId++)}`;
  });
  const runDiscussionTurn = vi.fn(async (agentId: string, prompt: string) => {
    const index = turnIndex++;
    turns.push({ agentId, prompt });
    options.onTurn?.(index);
    const error = options.throwOnTurn?.(index);
    if (error !== undefined) throw error;
    return options.replies?.[index] ?? `Speech ${String(index)} from ${agentId}`;
  });
  const getPersistentUsage = vi.fn((agentId: string) => options.usages?.[agentId]);
  const destroyPersistent = vi.fn(async (agentId: string) => {
    destroyed.push(agentId);
  });

  return {
    host: { spawnPersistent, runDiscussionTurn, getPersistentUsage, destroyPersistent },
    spawned,
    turns,
    destroyed,
    spawnPersistent,
    runDiscussionTurn,
    getPersistentUsage,
    destroyPersistent,
  };
}

const ZERO_USAGE: TokenUsage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };

function sumUsage(...usages: readonly TokenUsage[]): TokenUsage {
  return usages.reduce<TokenUsage>(
    (total, usage) => ({
      inputOther: total.inputOther + usage.inputOther,
      output: total.output + usage.output,
      inputCacheRead: total.inputCacheRead + usage.inputCacheRead,
      inputCacheCreation: total.inputCacheCreation + usage.inputCacheCreation,
    }),
    { ...ZERO_USAGE },
  );
}

describe('DiscussionContext', () => {
  it('renders transcript and tracks positions', () => {
    const context = new DiscussionContext();
    context.addEntry('coder', 'agent-0', 'First speech.', 1);
    context.addEntry('explore', 'agent-1', 'Second speech.', 1);

    expect(context.allEntries()).toEqual([
      { speaker: 'coder', agentId: 'agent-0', content: 'First speech.', round: 1 },
      { speaker: 'explore', agentId: 'agent-1', content: 'Second speech.', round: 1 },
    ]);
    expect(context.getRound()).toBe(1);
    expect(context.lastSpeaker()).toBe('explore');
    expect(context.getTranscript()).toBe('[coder] First speech.\n\n[explore] Second speech.');

    context.recordPosition('coder', 'Stance A', ['point 1'], 1);
    context.recordPosition('coder', 'Stance B', ['point 2'], 2);
    expect(context.getPosition('coder')?.stance).toBe('Stance B');
    expect(context.getPosition('coder')?.round).toBe(2);
    expect(context.getPositionsText()).toContain('[coder] Stance: Stance B');
  });

  it('detects cross-references with stance classification', () => {
    const context = new DiscussionContext();
    context.addEntry('coder', 'agent-0', 'I support the migration.', 1);
    context.addEntry('explore', 'agent-1', 'I oppose the migration.', 1);
    context.addEntry('coder', 'agent-0', 'I agree with @explore point about latency.', 2);
    context.addEntry('explore', 'agent-1', 'I disagree with @coder argument.', 2);

    const refs = context.allCrossReferences();
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      speaker: 'coder',
      targetSpeaker: 'explore',
      stance: 'agree',
      round: 2,
    });
    expect(refs[1]).toMatchObject({
      speaker: 'explore',
      targetSpeaker: 'coder',
      stance: 'disagree',
      round: 2,
    });
  });

  it('detects "as X said" references and does not self-reference', () => {
    const context = new DiscussionContext();
    context.addEntry('coder', 'agent-0', 'First speech.', 1);
    context.addEntry('explore', 'agent-1', 'As coder said, the plan is solid.', 2);

    expect(context.allCrossReferences()).toHaveLength(1);
    expect(context.allCrossReferences()[0]).toMatchObject({
      speaker: 'explore',
      targetSpeaker: 'coder',
    });
  });
});

describe('SwarmDiscussionCoordinator', () => {
  let controller: AbortController;

  beforeEach(() => {
    setLocale('en');
    controller = new AbortController();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs round-robin rounds, aggregates usage, and destroys all participants', async () => {
    const usageA: TokenUsage = { inputOther: 100, output: 50, inputCacheRead: 10, inputCacheCreation: 5 };
    const usageB: TokenUsage = { inputOther: 200, output: 80, inputCacheRead: 20, inputCacheCreation: 0 };
    const stub = createStubHost({ usages: { 'agent-0': usageA, 'agent-1': usageB } });
    const coordinator = new SwarmDiscussionCoordinator(stub.host);

    const result = await coordinator.discuss(
      {
        topic: 'How should we optimize the database?',
        participants: [
          { profileName: 'coder', roleDescription: 'You are a database researcher.' },
          { profileName: 'explore', roleDescription: 'You are a systems architect.' },
        ],
        maxRounds: 2,
      },
      controller.signal,
    );

    expect(stub.spawned.map((s) => s.profileName)).toEqual(['coder', 'explore']);
    expect(stub.spawned[0]).toMatchObject({
      prompt: '',
      parentToolCallId: 'discussion',
      runInBackground: false,
    });
    expect(stub.turns).toHaveLength(4);
    expect(stub.turns[0]!.agentId).toBe('agent-0');
    expect(stub.turns[1]!.agentId).toBe('agent-1');
    expect(stub.turns[2]!.agentId).toBe('agent-0');
    expect(stub.turns[3]!.agentId).toBe('agent-1');

    // First turn prompt: role + topic + first-speaker hint
    expect(stub.turns[0]!.prompt).toContain('[System] Your role:\nYou are a database researcher.');
    expect(stub.turns[0]!.prompt).toContain('Discussion topic:\nHow should we optimize the database?');
    expect(stub.turns[0]!.prompt).toContain('You are the first to speak.');

    // Later turn prompt: full transcript + continuation hint
    expect(stub.turns[1]!.prompt).toContain('[coder] Speech 0 from agent-0');
    expect(stub.turns[1]!.prompt).toContain('Continue the discussion based on what has been said so far.');

    expect(result.transcript).toHaveLength(4);
    expect(result.transcript[0]).toMatchObject({ speaker: 'coder', round: 1 });
    expect(result.transcript[1]).toMatchObject({ speaker: 'explore', round: 1 });
    expect(result.transcript[2]).toMatchObject({ speaker: 'coder', round: 2 });
    expect(result.transcript[3]).toMatchObject({ speaker: 'explore', round: 2 });
    expect(result.roundsCompleted).toBe(2);
    expect(result.endedBy).toBe('max_rounds');
    expect(result.usage).toEqual(sumUsage(usageA, usageB));
    expect(stub.destroyed).toEqual(['agent-0', 'agent-1']);
  });

  it('generates a summary on the first participant when summaryPrompt is provided', async () => {
    const stub = createStubHost();
    const coordinator = new SwarmDiscussionCoordinator(stub.host);

    const result = await coordinator.discuss(
      {
        topic: 'Topic',
        participants: [
          { profileName: 'coder', roleDescription: 'Role A.' },
          { profileName: 'explore', roleDescription: 'Role B.' },
        ],
        maxRounds: 1,
        summaryPrompt: 'Summarize the key decisions.',
      },
      controller.signal,
    );

    expect(stub.turns).toHaveLength(3);
    expect(stub.turns[2]!.agentId).toBe('agent-0');
    expect(stub.turns[2]!.prompt).toContain('Summarize the key decisions.');
    expect(stub.turns[2]!.prompt).toContain('Full discussion transcript:');
    expect(result.summary).toBe('Speech 2 from agent-0');
  });

  it('returns a zero usage when no participant reports usage', async () => {
    const stub = createStubHost();
    const coordinator = new SwarmDiscussionCoordinator(stub.host);

    const result = await coordinator.discuss(
      {
        topic: 'Topic',
        participants: [
          { profileName: 'coder', roleDescription: 'Role A.' },
          { profileName: 'explore', roleDescription: 'Role B.' },
        ],
        maxRounds: 1,
      },
      controller.signal,
    );

    expect(result.usage).toEqual(ZERO_USAGE);
  });

  it('ends with cancelled and still destroys participants when the signal aborts', async () => {
    const stub = createStubHost({
      onTurn: (index) => {
        if (index === 0) controller.abort();
      },
    });
    const coordinator = new SwarmDiscussionCoordinator(stub.host);

    const result = await coordinator.discuss(
      {
        topic: 'Topic',
        participants: [
          { profileName: 'coder', roleDescription: 'Role A.' },
          { profileName: 'explore', roleDescription: 'Role B.' },
        ],
        maxRounds: 3,
      },
      controller.signal,
    );

    expect(result.endedBy).toBe('cancelled');
    expect(result.transcript).toHaveLength(1);
    expect(result.roundsCompleted).toBe(1);
    expect(result.summary).toBe('');
    expect(stub.destroyed).toEqual(['agent-0', 'agent-1']);
  });

  it('ends with failed and still destroys participants when a turn throws', async () => {
    const stub = createStubHost({
      throwOnTurn: (index) => (index === 1 ? new Error('boom') : undefined),
    });
    const coordinator = new SwarmDiscussionCoordinator(stub.host);

    const result = await coordinator.discuss(
      {
        topic: 'Topic',
        participants: [
          { profileName: 'coder', roleDescription: 'Role A.' },
          { profileName: 'explore', roleDescription: 'Role B.' },
        ],
        maxRounds: 3,
      },
      controller.signal,
    );

    expect(result.endedBy).toBe('failed');
    expect(result.transcript).toHaveLength(1);
    expect(stub.destroyed).toEqual(['agent-0', 'agent-1']);
  });

  it('notifies the observer for each turn', async () => {
    const stub = createStubHost();
    const events: Array<{ readonly roleName: string; readonly round: number }> = [];
    const coordinator = new SwarmDiscussionCoordinator(stub.host, {
      observer: (event) => events.push({ roleName: event.roleName, round: event.round }),
    });

    await coordinator.discuss(
      {
        topic: 'Topic',
        participants: [
          { profileName: 'coder', roleDescription: 'Role A.' },
          { profileName: 'explore', roleDescription: 'Role B.' },
        ],
        maxRounds: 1,
      },
      controller.signal,
    );

    expect(events).toEqual([
      { roleName: 'coder', round: 1 },
      { roleName: 'explore', round: 1 },
    ]);
  });
});

describe('StructuredDebateCoordinator', () => {
  let controller: AbortController;

  beforeEach(() => {
    setLocale('en');
    controller = new AbortController();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs opening / free-debate / closing phases and counts position changes', async () => {
    const stub = createStubHost({
      replies: [
        'I support the migration.',
        'I oppose the migration.',
        'I support the migration still.',
        'I oppose the migration still.',
        'I now oppose the migration.',
        'I still oppose the migration.',
      ],
    });
    const coordinator = new StructuredDebateCoordinator(stub.host);

    const result = await coordinator.debate(
      {
        topic: 'Should we migrate?',
        participants: [
          { profileName: 'coder', roleDescription: 'Role A.' },
          { profileName: 'explore', roleDescription: 'Role B.' },
        ],
        maxDebateRounds: 1,
      },
      controller.signal,
    );

    expect(stub.spawned[0]).toMatchObject({ parentToolCallId: 'debate' });
    expect(stub.turns).toHaveLength(6);
    expect(stub.turns[0]!.prompt).toContain('=== OPENING STATEMENTS ===');
    expect(stub.turns[2]!.prompt).toContain('=== FREE DEBATE — Round 2 ===');
    expect(stub.turns[2]!.prompt).toContain('=== CURRENT POSITIONS ===');
    expect(stub.turns[4]!.prompt).toContain('=== CLOSING ARGUMENTS ===');

    expect(result.transcript).toHaveLength(6);
    expect(result.endedBy).toBe('completed');
    expect(result.phases).toEqual([
      { phase: 'opening', entryCount: 2 },
      { phase: 'free_debate', entryCount: 2 },
      { phase: 'closing', entryCount: 2 },
    ]);
    expect(result.positionChanges).toBe(2);
    expect(result.crossReferencesCount).toBe(0);
    expect(result.consensus).toBe('');
    expect(result.votingResult).toBe('');
    expect(stub.destroyed).toEqual(['agent-0', 'agent-1']);
  });

  it('injects assigned stances into opening statements', async () => {
    const stub = createStubHost();
    const coordinator = new StructuredDebateCoordinator(stub.host);

    await coordinator.debate(
      {
        topic: 'Topic',
        participants: [
          {
            profileName: 'coder',
            roleDescription: 'Role A.',
            assignedStance: 'Argue for migration',
          },
          { profileName: 'explore', roleDescription: 'Role B.' },
        ],
        maxDebateRounds: 0,
      },
      controller.signal,
    );

    expect(stub.turns[0]!.prompt).toContain('Your assigned stance: Argue for migration');
    expect(stub.turns[1]!.prompt).not.toContain('Your assigned stance');
  });

  it('detects cross-references between speakers during free debate', async () => {
    const stub = createStubHost({
      replies: [
        'I support the migration.',
        'I oppose the migration.',
        'I agree with @explore point about latency.',
        'I disagree with @coder argument.',
        'I now oppose the migration.',
        'I still oppose the migration.',
      ],
    });
    const coordinator = new StructuredDebateCoordinator(stub.host);

    const result = await coordinator.debate(
      {
        topic: 'Should we migrate?',
        participants: [
          { profileName: 'coder', roleDescription: 'Role A.' },
          { profileName: 'explore', roleDescription: 'Role B.' },
        ],
        maxDebateRounds: 1,
      },
      controller.signal,
    );

    expect(result.crossReferencesCount).toBe(2);
  });

  it('generates consensus and runs voting when enabled', async () => {
    const stub = createStubHost();
    const coordinator = new StructuredDebateCoordinator(stub.host);

    const result = await coordinator.debate(
      {
        topic: 'Should we migrate?',
        participants: [
          { profileName: 'coder', roleDescription: 'Role A.' },
          { profileName: 'explore', roleDescription: 'Role B.' },
        ],
        maxDebateRounds: 1,
        consensusPrompt: 'List points of consensus.',
        enableVoting: true,
      },
      controller.signal,
    );

    // 6 phase turns + 1 consensus turn + 2 votes + 1 tally
    expect(stub.turns).toHaveLength(10);
    expect(stub.turns[6]!.agentId).toBe('agent-0');
    expect(stub.turns[6]!.prompt).toContain('List points of consensus.');
    expect(stub.turns[6]!.prompt).toContain('Points of consensus (what everyone agrees on)');

    expect(stub.turns[7]!.prompt).toContain('=== VOTING PHASE ===');
    expect(stub.turns[8]!.prompt).toContain('=== VOTING PHASE ===');
    expect(stub.turns[9]!.prompt).toContain('Tally the votes from this debate');
    expect(stub.turns[9]!.prompt).toContain('[coder] Speech 7 from agent-0');
    expect(stub.turns[9]!.prompt).toContain('[explore] Speech 8 from agent-1');

    expect(result.consensus).toBe('Speech 6 from agent-0');
    expect(result.votingResult).toBe('Speech 9 from agent-0');
  });

  it('keeps voting best-effort when a vote fails', async () => {
    const stub = createStubHost({
      throwOnTurn: (index) => (index === 7 ? new Error('vote failed') : undefined),
    });
    const coordinator = new StructuredDebateCoordinator(stub.host);

    const result = await coordinator.debate(
      {
        topic: 'Topic',
        participants: [
          { profileName: 'coder', roleDescription: 'Role A.' },
          { profileName: 'explore', roleDescription: 'Role B.' },
        ],
        maxDebateRounds: 1,
        enableVoting: true,
      },
      controller.signal,
    );

    expect(result.votingResult).toBe('Speech 8 from agent-0');
    expect(stub.turns[8]!.prompt).toContain('[coder] Speech 6 from agent-0');
    expect(stub.turns[8]!.prompt).toContain('[explore] <vote not cast>');
  });

  it('ends with cancelled when the signal aborts mid-debate', async () => {
    const stub = createStubHost({
      onTurn: (index) => {
        if (index === 0) controller.abort();
      },
    });
    const coordinator = new StructuredDebateCoordinator(stub.host);

    const result = await coordinator.debate(
      {
        topic: 'Topic',
        participants: [
          { profileName: 'coder', roleDescription: 'Role A.' },
          { profileName: 'explore', roleDescription: 'Role B.' },
        ],
        maxDebateRounds: 2,
      },
      controller.signal,
    );

    expect(result.endedBy).toBe('cancelled');
    expect(result.transcript).toHaveLength(1);
    expect(result.consensus).toBe('');
    expect(stub.destroyed).toEqual(['agent-0', 'agent-1']);
  });

  it('ends with failed and still destroys participants when a turn throws', async () => {
    const stub = createStubHost({
      throwOnTurn: (index) => (index === 3 ? new Error('boom') : undefined),
    });
    const coordinator = new StructuredDebateCoordinator(stub.host);

    const result = await coordinator.debate(
      {
        topic: 'Topic',
        participants: [
          { profileName: 'coder', roleDescription: 'Role A.' },
          { profileName: 'explore', roleDescription: 'Role B.' },
        ],
        maxDebateRounds: 2,
      },
      controller.signal,
    );

    expect(result.endedBy).toBe('failed');
    expect(result.transcript).toHaveLength(3);
    expect(result.positionChanges).toBe(0);
    expect(stub.destroyed).toEqual(['agent-0', 'agent-1']);
  });
});
