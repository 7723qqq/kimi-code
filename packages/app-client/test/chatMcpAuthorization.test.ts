import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationFrame, ConversationTurn } from '@moonshot-ai/app-core/conversation';
import {
  chatMcpOpenBlocked,
  createChatMcpAutoOpen,
  openChatMcpAuthorization,
} from '../src/composables/chatMcpAuthorization';
import { newPromptId } from '../src/client/promptId';

const AT = '2026-01-01T00:00:00.000Z';

const originalWindow = (globalThis as { window?: unknown }).window;
const originalDocument = (globalThis as { document?: unknown }).document;

function installDesktop(openExternal: (url: string) => Promise<void>): void {
  (globalThis as { window?: unknown }).window = { kimiDesktop: { openExternal } };
  (globalThis as { document?: unknown }).document = {
    visibilityState: 'visible',
    hasFocus: () => true,
  };
}

function opener(promptId: string): ConversationTurn['items'][number] {
  return {
    type: 'user_message',
    item_id: promptId,
    status: 'ended',
    outcome: 'completed',
    created_at: AT,
    placement: 'opener',
    prompt_ids: [promptId],
    origin: { kind: 'user' },
    text: 'use example',
    attachments: [],
    skills: [],
  };
}

function tool(fields: Record<string, unknown>): ConversationTurn['items'][number] {
  return {
    type: 'tool_call',
    item_id: 'auth',
    status: 'running',
    created_at: AT,
    started_at: AT,
    stage: 'executing',
    name: 'mcp__example__authenticate',
    display: {
      kind: 'generic',
      summary: 'Authenticate example',
      detail: { kind: 'mcp_oauth', serverName: 'example' },
    },
    fields,
  } as ConversationTurn['items'][number];
}

function turn(promptId: string, item: ConversationTurn['items'][number]): ConversationTurn {
  return {
    turn_id: 't0',
    ordinal: 0,
    turn_number: 1,
    kind: 'agent',
    status: 'running',
    outcome: undefined,
    started_at: AT,
    steps: [],
    items: [opener(promptId), item],
  };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serverName: 'example',
    waitId: 'wait-1',
    authorizationUrl: 'https://auth.example.test/authorize?state=test',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
  (globalThis as { document?: unknown }).document = originalDocument;
  vi.restoreAllMocks();
});

describe('chat MCP authorization auto-open', () => {
  it('opens a live wait once, only for the foreground prompt this client sent', async () => {
    const openExternal = vi.fn(async () => {});
    installDesktop(openExternal);
    const promptId = newPromptId();
    const fields = { 'mcp.oauth.authorization_url': request() };
    const activeTurn = turn(promptId, tool(fields));
    const autoOpen = createChatMcpAutoOpen();
    const frame: ConversationFrame = {
      type: 'item.updated',
      turn_id: activeTurn.turn_id,
      item_id: 'auth',
      set: { fields },
    };

    autoOpen(frame, activeTurn, true);
    autoOpen(frame, activeTurn, true);
    expect(openExternal.mock.calls).toEqual([
      ['https://auth.example.test/authorize?state=test'],
    ]);

    autoOpen(frame, turn('another-client', tool(fields)), true);
    expect(openExternal).toHaveBeenCalledTimes(1);

    autoOpen({ ...frame, item_id: 'auth-2' }, activeTurn, false);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('observes a waiting snapshot without opening a browser', () => {
    const openExternal = vi.fn(async () => {});
    installDesktop(openExternal);
    const fields = { 'mcp.oauth.authorization_url': request() };
    const frame: ConversationFrame = {
      type: 'turns',
      has_more: false,
      turns: [turn(newPromptId(), tool(fields))],
    };

    createChatMcpAutoOpen()(frame, undefined, true);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects expired and non-http authorization links and records a failed open', async () => {
    const openExternal = vi.fn(async () => {});
    installDesktop(openExternal);

    await openChatMcpAuthorization({
      serverName: 'example',
      waitId: 'expired',
      authorizationUrl: 'https://auth.example.test/authorize',
      expiresAt: Date.now() - 1,
    });
    await openChatMcpAuthorization({
      serverName: 'example',
      waitId: 'file',
      authorizationUrl: 'file:///tmp/auth',
      expiresAt: Date.now() + 60_000,
    });
    expect(openExternal).not.toHaveBeenCalled();

    openExternal.mockRejectedValueOnce(new Error('no browser'));
    await openChatMcpAuthorization({
      serverName: 'example',
      waitId: 'blocked',
      authorizationUrl: 'https://auth.example.test/authorize',
      expiresAt: Date.now() + 60_000,
    });
    expect(chatMcpOpenBlocked('blocked')).toBe(true);

    await openChatMcpAuthorization({
      serverName: 'example',
      waitId: 'blocked',
      authorizationUrl: 'https://auth.example.test/authorize',
      expiresAt: Date.now() + 60_000,
    });
    expect(chatMcpOpenBlocked('blocked')).toBe(false);
  });
});
