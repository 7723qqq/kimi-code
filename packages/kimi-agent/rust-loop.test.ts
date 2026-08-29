import { describe, expect, it } from 'vitest';

import { classifyRpcMessage, mapStopReason, projectHostMessageToWire } from './rust-loop';

describe('classifyRpcMessage', () => {
  it('classifies a host request (method + id) as a request', () => {
    expect(
      classifyRpcMessage({ jsonrpc: '2.0', id: 1, method: 'host/execute_tool', params: {} }),
    ).toBe('request');
  });

  it('classifies a result response (id, no method) as a response', () => {
    expect(classifyRpcMessage({ jsonrpc: '2.0', id: 1, result: {} })).toBe('response');
  });

  it('classifies an error response (id, no method) as a response', () => {
    expect(classifyRpcMessage({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } })).toBe(
      'response',
    );
  });

  // Regression: a Rust host request carrying an id that collides with a pending
  // request id (both sides allocate ids from 1) must route as a request, not be
  // mis-consumed as the pending request's response.
  it('routes a colliding host request as a request, not a response', () => {
    const colliding = { jsonrpc: '2.0' as const, id: 1, method: 'host/llm_chat', params: {} };
    expect(classifyRpcMessage(colliding)).toBe('request');
  });

  it('ignores a notification (method, no id)', () => {
    expect(classifyRpcMessage({ jsonrpc: '2.0', method: 'host/log', params: {} })).toBe('ignore');
  });

  it('ignores a message with neither method nor id', () => {
    expect(classifyRpcMessage({ jsonrpc: '2.0' })).toBe('ignore');
  });
});

describe('mapStopReason', () => {
  it('maps EndTurn to completed', () => {
    expect(mapStopReason('EndTurn')).toBe('completed');
  });

  it('maps MaxTokens to truncated', () => {
    expect(mapStopReason('MaxTokens')).toBe('truncated');
  });

  it('maps Filtered to filtered', () => {
    expect(mapStopReason('Filtered')).toBe('filtered');
  });

  it('maps Paused to paused', () => {
    expect(mapStopReason('Paused')).toBe('paused');
  });

  it('maps Aborted to other', () => {
    expect(mapStopReason('Aborted')).toBe('other');
  });

  it('maps BudgetLimited to other', () => {
    expect(mapStopReason('BudgetLimited')).toBe('other');
  });

  it('maps unknown reason to other', () => {
    expect(mapStopReason('SomethingElse')).toBe('other');
  });

  it('maps empty string to other', () => {
    expect(mapStopReason('')).toBe('other');
  });
});

describe('projectHostMessageToWire', () => {
  it('projects text parts and joins them into content', () => {
    const wire = projectHostMessageToWire({
      role: 'user',
      content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }],
    });
    expect(wire.role).toBe('user');
    expect(wire.content).toBe('hello world');
    expect(wire.blocks).toBeUndefined();
  });

  it('drops think parts from the wire (reasoning hosted separately)', () => {
    const wire = projectHostMessageToWire({
      role: 'assistant',
      content: [
        { type: 'text', text: 'answer' },
        { type: 'think', think: 'internal reasoning' },
      ],
    });
    expect(wire.content).toBe('answer');
    expect(wire.blocks).toBeUndefined();
  });

  it('projects image/audio/video blocks with their urls', () => {
    const wire = projectHostMessageToWire({
      role: 'user',
      content: [
        { type: 'image_url', imageUrl: { url: 'https://e.com/a.png', id: 'i1' } },
        { type: 'audio_url', audioUrl: { url: 'https://e.com/a.mp3', id: 'a1' } },
        { type: 'video_url', videoUrl: { url: 'https://e.com/v.mp4', id: 'v1' } },
      ],
    });
    expect(wire.content).toBe('');
    expect(wire.blocks).toEqual([
      { type: 'image_url', url: 'https://e.com/a.png' },
      { type: 'audio_url', url: 'https://e.com/a.mp3', id: 'a1' },
      { type: 'video_url', url: 'https://e.com/v.mp4', id: 'v1' },
    ]);
  });

  it('skips malformed parts and unknown part types', () => {
    const wire = projectHostMessageToWire({
      role: 'user',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'text' } as never,
        { type: 'image_url', imageUrl: { url: undefined } } as never,
        { type: 'hologram', data: 'x' } as never,
      ],
    });
    expect(wire.content).toBe('ok');
    expect(wire.blocks).toBeUndefined();
  });

  it('projects tool_calls and tool_call_id', () => {
    const wire = projectHostMessageToWire({
      role: 'assistant',
      content: [],
      toolCalls: [{ id: 'c1', name: 'Read', arguments: '{"path":"/a"}' }],
    });
    expect(wire.tool_calls).toEqual([
      { id: 'c1', name: 'Read', arguments: { path: '/a' } },
    ]);
    expect(wire.blocks).toBeUndefined();
  });

  it('serializes null tool arguments as an empty object', () => {
    const wire = projectHostMessageToWire({
      role: 'assistant',
      content: [],
      toolCalls: [{ id: 'c2', name: 'Bash', arguments: null }],
    });
    expect(wire.tool_calls).toEqual([{ id: 'c2', name: 'Bash', arguments: {} }]);
  });
});
