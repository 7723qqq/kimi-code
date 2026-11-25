import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AssistantDelta,
  ThinkingDelta,
  ToolCallDelta,
  ToolProgress,
  ContextAppendMessage,
  ContextAppendLoopEvent,
  ContextApplyCompaction,
  ContextUndo,
  TurnStepRetrying,
  IAgentLifecycleService,
  IAgentLoopService,
  IEventDispatcher,
  IModelCatalog,
  IWireService,
  TaskStarted,
  TurnEnded,
  TurnPrompt,
  TurnStepInterrupted,
  getLiveSessionById,
  type AgentTaskInfo,
  type ContextMessage,
} from '@moonshot-ai/agent-core-v2';
import type { LoopRecordedEvent } from '@moonshot-ai/agent-core-v2/agent/contextMemory/loopEventFold';
import type { Event2 } from '@moonshot-ai/agent-core-v2/app/event/event2';

import {
  ConversationFeed,
  type ConversationEvent,
} from '../../src/services/conversation/conversationFeed';
import { ConversationService } from '../../src/services/conversation/conversationService';
import { startServer, type RunningServer } from '../../src/start';
import { authHeaders } from '../helpers/auth';
import { fakeModelCatalog } from '../helpers/fakeModelCatalog';
import { TEST_HOST_IDENTITY } from '../helpers/hostIdentity';

const feedSpy = spyOn(ConversationService.prototype, 'feed');
let server: RunningServer;
let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'kimi-conversation-feed-'));
  server = await startServer({
    hostIdentity: TEST_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir: home,
    logLevel: 'silent',
    seeds: [[IModelCatalog, fakeModelCatalog()]],
  });
});
afterAll(async () => {
  feedSpy.mockRestore();
  await server?.close();
  if (home !== undefined) await rm(home, { recursive: true, force: true });
});

async function harness() {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/sessions`, {
    method: 'POST',
    headers: authHeaders(server, { 'content-type': 'application/json' }),
    body: JSON.stringify({ metadata: { cwd: home } }),
  });
  const body = (await response.json()) as { code: number; data: { id: string } };
  expect(body.code).toBe(0);
  const session = getLiveSessionById(server.core.accessor, body.data.id)!;
  const lifecycle = session.accessor.get(IAgentLifecycleService);
  await lifecycle.create({ agentId: 'main' });
  const handle = lifecycle.handleOf('main')!;
  const dispatcher = handle.accessor.get(IEventDispatcher);
  const page = await fetch(
    `http://127.0.0.1:${server.port}/api/v1/sessions/${body.data.id}/agents/main/turns`,
    { headers: authHeaders(server) },
  );
  expect(page.status).toBe(200);
  const feed = await feedSpy.mock.results.at(-1)!.value;
  if (!(feed instanceof ConversationFeed))
    throw new Error('route did not resolve a conversation feed');
  await feed.ready;
  const events: ConversationEvent[] = [];
  feed.subscribe((event) => events.push(event));
  const dispatch = async (event: Event2) => {
    await dispatcher.dispatch(event);
  };
  const message = (value: ContextMessage) =>
    dispatch(new ContextAppendMessage({ agentId: 'main', message: value }));
  const loop = (event: LoopRecordedEvent) =>
    dispatch(new ContextAppendLoopEvent({ agentId: 'main', event }));
  const prompt = async (turnId = 1) => {
    await dispatch(
      new TurnPrompt({
        agentId: 'main',
        turnId,
        promptId: `p${turnId}`,
        origin: { kind: 'user' },
        input: [{ type: 'text', text: 'run' }],
      }),
    );
    await message({
      role: 'user',
      id: `p${turnId}`,
      origin: { kind: 'user' },
      content: [{ type: 'text', text: 'run' }],
      toolCalls: [],
    });
  };
  const step = (uuid = 's1', step = 1, turnId = '1') =>
    loop({ type: 'step.begin', uuid, step, turnId });
  const call = (toolCallId = 'c1', name = 'Bash') =>
    loop({ type: 'tool.call', stepUuid: 's1', turnId: '1', step: 1, toolCallId, name, args: {} });
  const result = (toolCallId: string, output: string, isError = false) =>
    loop({ type: 'tool.result', toolCallId, result: { output, isError } });
  const end = (reason: 'completed' | 'cancelled' | 'failed' = 'completed', turnId = 1) =>
    dispatch(new TurnEnded({ agentId: 'main', turnId, reason }));
  return {
    feed,
    events,
    handle,
    dispatcher,
    dispatch,
    message,
    loop,
    prompt,
    step,
    call,
    result,
    end,
  };
}

function toolCallOf(feed: ConversationFeed, id: string) {
  const item = feed
    .turns()
    .flatMap((turn) => turn.items)
    .find((item) => item.item_id === id);
  if (item?.type !== 'tool_call') throw new Error(`no tool call ${id}`);
  return item;
}

function processTask(taskId: string, parentToolCallId: string): AgentTaskInfo {
  return {
    kind: 'process',
    taskId,
    parentToolCallId,
    description: 'run',
    command: 'bun test',
    pid: 123,
    exitCode: null,
    status: 'running',
    startedAt: 0,
    endedAt: null,
  };
}

describe('recorded conversation feed', () => {
  it('streams text, reasoning and tool input before durable completion without duplicate items', async () => {
    const t = await harness();
    try {
      await t.prompt();
      await t.step();
      await t.dispatch(new ThinkingDelta({ agentId: 'main', turnId: 1, block: 0, delta: 'plan' }));
      await t.dispatch(
        new AssistantDelta({ agentId: 'main', turnId: 1, block: 1, delta: 'hello' }),
      );
      await t.dispatch(
        new AssistantDelta({ agentId: 'main', turnId: 1, block: 1, delta: ' world' }),
      );
      await t.dispatch(
        new ToolCallDelta({
          agentId: 'main',
          turnId: 1,
          toolCallId: 'c1',
          name: 'Bash',
          argumentsPart: '{',
        }),
      );
      await t.dispatch(
        new ToolCallDelta({ agentId: 'main', turnId: 1, toolCallId: 'c1', argumentsPart: '}' }),
      );
      const live = (await t.feed.page(undefined, 10)).turns[0]!;
      expect(live.items).toContainEqual(
        expect.objectContaining({
          item_id: 's1:1',
          text: 'hello world',
          status: 'running',
          step_index: 1,
        }),
      );
      expect(t.events).toContainEqual(
        expect.objectContaining({ type: 'item.delta', item_id: 's1:1', delta: ' world' }),
      );
      expect(live.items).toContainEqual(
        expect.objectContaining({ item_id: 'c1', input_text: '{}', stage: 'input' }),
      );
      await t.loop({
        type: 'content.part',
        stepUuid: 's1',
        turnId: '1',
        step: 1,
        block: 0,
        part: { type: 'think', think: 'plan' },
        startedAt: 4000,
        durationMs: 2500,
      });
      await t.loop({
        type: 'content.part',
        stepUuid: 's1',
        turnId: '1',
        step: 1,
        block: 1,
        part: { type: 'text', text: 'hello world' },
      });
      await t.call();
      await t.dispatch(
        new ToolProgress({
          agentId: 'main',
          turnId: 1,
          toolCallId: 'c1',
          update: { kind: 'stdout', text: 'partial' },
        }),
      );
      expect((await t.feed.page(undefined, 10)).turns[0]!.items).toContainEqual(
        expect.objectContaining({ item_id: 'c1', output: 'partial' }),
      );
      await t.result('c1', 'final');
      await t.loop({ type: 'step.end', uuid: 's1', turnId: '1', step: 1, finishReason: 'stop' });
      await t.end();
      const turn = (await t.feed.page(undefined, 10)).turns[0]!;
      expect(turn.items.map((item) => item.item_id)).toEqual(['p1', 's1:0', 's1:1', 'c1']);
      expect(turn.items[1]).toMatchObject({
        duration_ms: 2500,
        started_at: new Date(4000).toISOString(),
      });
      expect(turn.steps).toHaveLength(1);
      expect(toolCallOf(t.feed, 'c1')).toMatchObject({ output: 'final', status: 'ended' });
      await t.handle.accessor.get(IWireService).flush();
      const before = t.feed.turns();
      t.feed.dispose();
      const cold = new ConversationFeed(t.handle);
      try {
        await cold.ready;
        expect(cold.turns()).toEqual(before);
      } finally {
        cold.dispose();
      }
    } finally {
      t.feed.dispose();
    }
  });

  it('merges tool update fields into the running item and drops them after completion', async () => {
    const t = await harness();
    try {
      await t.prompt();
      await t.step();
      await t.call('c1', 'mcp__example__authenticate');
      const request = {
        waitId: 'wait-1',
        serverName: 'example',
        authorizationUrl: 'https://auth.example.test/authorize?state=test',
        expiresAt: Date.now() + 60_000,
      };
      const fields = { 'mcp.oauth.authorization_url': request };
      await t.dispatch(
        new ToolProgress({
          agentId: 'main',
          turnId: 1,
          toolCallId: 'c1',
          update: { kind: 'custom', fields },
        }),
      );
      const live = (await t.feed.page(undefined, 10)).turns[0]!.items.find(
        (item) => item.item_id === 'c1',
      );
      expect(live).toMatchObject({ fields });
      expect(t.events).toContainEqual(
        expect.objectContaining({
          type: 'item.updated',
          item_id: 'c1',
          set: expect.objectContaining({ fields }),
        }),
      );
      await t.result('c1', 'Connected');
      const ended = (await t.feed.page(undefined, 10)).turns[0]!.items.find(
        (item) => item.item_id === 'c1',
      );
      expect(ended).toMatchObject({ status: 'ended' });
      expect(JSON.stringify(ended)).not.toContain(request.authorizationUrl);
    } finally {
      t.feed.dispose();
    }
  });

  it('preserves completed and failed tools while marking only stopped work interrupted', async () => {
    const t = await harness();
    try {
      await t.prompt();
      await t.step();
      await t.call('read0', 'Read');
      await t.call('read1', 'Read');
      await t.call();
      await t.result('read0', 'file body');
      await t.result('read1', 'file not found', true);
      await t.dispatch(
        new TurnStepInterrupted({
          agentId: 'main',
          turnId: 1,
          step: 1,
          stepId: 's1',
          reason: 'aborted',
        }),
      );
      await t.result('c1', 'Interrupted by user', true);
      await t.end('cancelled');
      expect(toolCallOf(t.feed, 'read0')).toMatchObject({
        outcome: 'completed',
        output: 'file body',
      });
      expect(toolCallOf(t.feed, 'read1')).toMatchObject({
        outcome: 'failed',
        error: 'file not found',
      });
      expect(toolCallOf(t.feed, 'c1')).toMatchObject({
        outcome: 'interrupted',
        error: 'Interrupted by user',
      });
      expect(t.events).toContainEqual(
        expect.objectContaining({
          type: 'item.ended',
          item: expect.objectContaining({ item_id: 'c1', outcome: 'interrupted' }),
        }),
      );
    } finally {
      t.feed.dispose();
    }
  });

  it('does not mistake an error interruption for a user stop', async () => {
    const t = await harness();
    try {
      await t.prompt();
      await t.step();
      await t.call();
      await t.dispatch(
        new TurnStepInterrupted({
          agentId: 'main',
          turnId: 1,
          step: 1,
          stepId: 's1',
          reason: 'error',
        }),
      );
      await t.result('c1', 'Tool aborted', true);
      await t.end('failed');
      expect(toolCallOf(t.feed, 'c1')).toMatchObject({ outcome: 'failed', error: 'Tool aborted' });
    } finally {
      t.feed.dispose();
    }
  });

  it('removes failed-attempt items on retry and keeps tool indexes correct', async () => {
    const t = await harness();
    try {
      await t.prompt();
      await t.step();
      await t.loop({
        type: 'content.part',
        stepUuid: 's1',
        turnId: '1',
        step: 1,
        block: 0,
        part: { type: 'text', text: 'discard' },
      });
      await t.call();
      await t.loop({ type: 'step.end', uuid: 's1', finishReason: 'error' });
      await t.dispatch(
        new TurnStepRetrying({
          agentId: 'main',
          turnId: 1,
          step: 1,
          stepId: 's1',
          failedAttempt: 1,
          nextAttempt: 2,
          maxAttempts: 3,
          delayMs: 0,
          errorName: 'Error',
          errorMessage: 'retry',
        }),
      );
      expect(t.feed.turns()[0]!.items.some((item) => item.item_id === 's1:0')).toBe(false);
      await t.step('s2', 2);
      await t.result('c1', 'done');
      expect(t.events).toContainEqual(
        expect.objectContaining({ type: 'item.removed', item_id: 's1:0' }),
      );
      expect(toolCallOf(t.feed, 'c1')).toMatchObject({ output: 'done' });
    } finally {
      t.feed.dispose();
    }
  });

  it('preserves history and recorded metadata across compaction and late replay', async () => {
    const t = await harness();
    try {
      await t.prompt();
      await t.step();
      await t.call();
      await t.result('c1', 'done');
      await t.end();
      const before = t.feed.turns()[0];
      await t.dispatch(
        new ContextApplyCompaction({
          agentId: 'main',
          summary: 'summary',
          compactedCount: 2,
          tokensBefore: 1000,
          tokensAfter: 100,
        }),
      );
      expect(t.feed.turns()[0]).toEqual(before);
      expect(t.feed.turns().at(-1)?.items.at(-1)).toMatchObject({
        kind: 'compaction',
        summary: 'summary',
      });
      await t.handle.accessor.get(IWireService).flush();
      t.feed.dispose();
      const cold = new ConversationFeed(t.handle);
      try {
        await cold.ready;
        expect(cold.turns()).toEqual(t.feed.turns());
      } finally {
        cold.dispose();
      }
    } finally {
      t.feed.dispose();
    }
  });

  it('serializes racing undo requests through the actual undo service', async () => {
    const t = await harness();
    try {
      for (let id = 1; id <= 3; id++) {
        await t.prompt(id);
        await t.end('completed', id);
      }
      const ids = t.feed.turns().map((turn) => turn.turn_id);
      const results = await Promise.allSettled([t.feed.undo(ids[2]!), t.feed.undo(ids[2]!)]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
      expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
        code: 'turn.not_found',
      });
      expect(t.feed.turns().map((turn) => turn.turn_id)).toEqual(ids.slice(0, 2));
    } finally {
      t.feed.dispose();
    }
  });

  it('publishes immutable task links, restores every task kind and ignores duplicate links', async () => {
    const t = await harness();
    try {
      await t.prompt();
      await t.step();
      await t.call();
      await t.call('c2', 'Agent');
      await t.call('c3', 'AskUserQuestion');
      await t.call('c4', 'Read');
      const before = toolCallOf(t.feed, 'c1');
      const base = { description: 'ask', status: 'completed', startedAt: 0, endedAt: 1 };
      for (const info of [
        processTask('bash-1', 'c1'),
        { ...base, kind: 'agent', taskId: 'agent-1', parentToolCallId: 'c2' },
        { ...base, kind: 'question', taskId: 'question-1', toolCallId: 'c3', questionCount: 1 },
        processTask('missing', 'absent'),
      ]) {
        await t.dispatch(new TaskStarted({ agentId: 'main', info: info as AgentTaskInfo }));
      }
      expect(before.task_id).toBeUndefined();
      expect(t.events).toContainEqual(
        expect.objectContaining({
          type: 'item.updated',
          item_id: 'c1',
          set: { task_id: 'bash-1' },
        }),
      );
      t.events.length = 0;
      await t.dispatch(new TaskStarted({ agentId: 'main', info: processTask('bash-1', 'c1') }));
      expect(t.events).toEqual([]);
      await t.result('c1', 'no id in output');
      await t.end();
      expect(toolCallOf(t.feed, 'c4').task_id).toBeUndefined();
      await t.handle.accessor.get(IWireService).flush();
      t.feed.dispose();
      const cold = new ConversationFeed(t.handle);
      try {
        await cold.ready;
        expect(cold.turns()).toEqual(t.feed.turns());
        expect(toolCallOf(cold, 'c1').task_id).toBe('bash-1');
        expect(toolCallOf(cold, 'c2').task_id).toBe('agent-1');
        expect(toolCallOf(cold, 'c3').task_id).toBe('question-1');
      } finally {
        cold.dispose();
      }
    } finally {
      t.feed.dispose();
    }
  });

  it('does not recreate tools after undo or publish events after disposal', async () => {
    const t = await harness();
    try {
      await t.prompt();
      await t.step();
      await t.call();
      await t.dispatch(new ContextUndo({ agentId: 'main', count: 1 }));
      t.events.length = 0;
      await t.dispatch(new TaskStarted({ agentId: 'main', info: processTask('bash-2', 'c1') }));
      expect(t.feed.turns()).toEqual([]);
      expect(t.events).toEqual([]);
      t.feed.dispose();
      await t.dispatch(new TaskStarted({ agentId: 'main', info: processTask('bash-3', 'c1') }));
      expect(t.events).toEqual([]);
    } finally {
      t.feed.dispose();
    }
  });

  const reply = (text: string): ContextMessage => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    toolCalls: [],
  });

  it('reuses the turn request ID only when its step produced the rated reply', async () => {
    const t = await harness();
    try {
      await t.prompt();
      await t.step('answer');
      await t.loop({ type: 'content.part', turnId: '1', step: 1, stepUuid: 'answer', part: { type: 'text', text: 'First answer' }, block: 0 });
      await t.loop({ type: 'step.end', uuid: 'answer', turnId: '1', step: 1, finishReason: 'stop' });
      await t.dispatch(new TurnEnded({ agentId: 'main', turnId: 1, reason: 'completed', requestId: 'first-request' }));
      const turn = t.feed.turns()[0]!;
      const answer = turn.items.find((item) => item.type === 'assistant_message');
      expect(answer).toBeDefined();
      expect(t.feed.feedbackTurn(turn.turn_id, answer!.item_id)).toMatchObject({ requestId: 'first-request' });
      expect(t.feed.feedbackTurn(turn.turn_id, 'missing')).toBeUndefined();

      const failed = await harness();
      try {
        await failed.prompt();
        await failed.step('explain');
        await failed.loop({ type: 'content.part', turnId: '1', step: 1, stepUuid: 'explain', part: { type: 'text', text: 'I will read the file.' }, block: 0 });
        await failed.loop({ type: 'step.end', uuid: 'explain', turnId: '1', step: 1, finishReason: 'stop' });
        await failed.step('failed', 2);
        await failed.loop({ type: 'step.end', uuid: 'failed', turnId: '1', step: 2, finishReason: 'error' });
        await failed.dispatch(new TurnEnded({ agentId: 'main', turnId: 1, reason: 'failed', requestId: 'failed-request' }));
        const failedTurn = failed.feed.turns()[0]!;
        expect(failed.feed.feedbackTurn(failedTurn.turn_id)).toEqual({});
      } finally {
        failed.feed.dispose();
      }
    } finally {
      t.feed.dispose();
    }
  });

  it('drops reply attribution when the turn is undone', async () => {
    const first = { step: 1, role: 'step' as const, provider: 'example', model: 'earlier', isKfc: false, requestId: 'first-request' };
    const child = { ...first, role: 'subagent' as const, model: 'helper', requestId: 'child-request' };
    const last = { ...first, step: 2, model: 'later', requestId: 'last-request' };
    const t = await harness();
    try {
      await t.prompt();
      await t.step('s1', 1);
      await t.loop({ type: 'content.part', turnId: '1', step: 1, stepUuid: 's1', part: { type: 'text', text: 'First reply' }, block: 0 });
      await t.loop({ type: 'step.end', uuid: 's1', turnId: '1', step: 1, finishReason: 'stop' });
      await t.message({
        role: 'user',
        id: 'followup',
        origin: { kind: 'user', inTurn: true },
        content: [{ type: 'text', text: 'Follow-up question' }],
        toolCalls: [],
      });
      await t.step('s2', 2);
      await t.loop({ type: 'content.part', turnId: '1', step: 2, stepUuid: 's2', part: { type: 'text', text: 'Last reply' }, block: 0 });
      await t.loop({ type: 'step.end', uuid: 's2', turnId: '1', step: 2, finishReason: 'stop' });
      await t.dispatch(new TurnEnded({
        agentId: 'main', turnId: 1, reason: 'completed',
        requestId: last.requestId,
        replyModel: { model: last.model, provider: last.provider },
        modelSteps: [first, child, last],
      }));
      const turn = t.feed.turns()[0]!;
      const firstReply = turn.items.find((item) => item.type === 'assistant_message' && item.text === 'First reply');
      const lastReply = turn.items.find((item) => item.type === 'assistant_message' && item.text === 'Last reply');
      expect(firstReply).toBeDefined();
      expect(lastReply).toBeDefined();
      expect(t.feed.feedbackTurn(turn.turn_id, lastReply!.item_id)).toMatchObject({ requestId: last.requestId });

      await t.dispatch(new ContextUndo({ agentId: 'main', count: 1 }));

      expect(t.feed.feedbackTurn(turn.turn_id, firstReply!.item_id)).toBeUndefined();
      await t.dispatcher.restore();
      expect(t.feed.feedbackTurn(turn.turn_id, firstReply!.item_id)).toBeUndefined();
    } finally {
      t.feed.dispose();
    }
  });
});

