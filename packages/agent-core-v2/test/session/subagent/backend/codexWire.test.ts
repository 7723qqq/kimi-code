import { describe, expect, it } from 'vitest';

import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import { CodexWire, CodexWireClosedError } from '#/session/subagent/backend/codexWire';
import type { IProcess } from '#/session/process/processRunner';

interface WireHarness {
  readonly wire: CodexWire;
  readonly requests: Array<Record<string, unknown>>;
  write(message: Record<string, unknown>): void;
  close(): void;
}

function makeHarness(): WireHarness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const requests: Array<Record<string, unknown>> = [];
  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  lines.on('line', (line: string) => {
    if (line.trim().length > 0) requests.push(JSON.parse(line) as Record<string, unknown>);
  });
  const process: IProcess = {
    stdin,
    stdout,
    stderr: new PassThrough(),
    pid: 1,
    exitCode: null,
    wait: async () => 0,
    kill: async () => undefined,
    dispose: () => undefined,
  };
  const wire = new CodexWire(process);
  return {
    wire,
    requests,
    write: (message) => stdout.write(`${JSON.stringify(message)}\n`),
    close: () => stdout.end(),
  };
}

describe('CodexWire', () => {
  it('sends a request and resolves with the response', async () => {
    const harness = makeHarness();
    const promise = harness.wire.request('initialize', { protocolVersion: 1 });
    const request = harness.requests.at(-1);
    expect(request).toMatchObject({ jsonrpc: '2.0', method: 'initialize' });
    harness.write({ jsonrpc: '2.0', id: (request as { id: number }).id, result: { protocolVersion: 1 } });
    await expect(promise).resolves.toEqual({ protocolVersion: 1 });
  });

  it('rejects with the server error message', async () => {
    const harness = makeHarness();
    const promise = harness.wire.request('runTurn', {});
    const request = harness.requests.at(-1);
    harness.write({
      jsonrpc: '2.0',
      id: (request as { id: number }).id,
      error: { code: -32603, message: 'boom' },
    });
    await expect(promise).rejects.toThrow('boom');
  });

  it('dispatches notifications to registered handlers', async () => {
    const harness = makeHarness();
    const seen: unknown[] = [];
    harness.wire.onNotification('turn/updated', (params) => {
      seen.push(params);
    });
    harness.write({ jsonrpc: '2.0', method: 'turn/updated', params: { text: 'hi' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual([{ text: 'hi' }]);
  });

  it('rejects pending requests when the transport closes', async () => {
    const harness = makeHarness();
    const promise = harness.wire.request('runTurn', {});
    harness.close();
    await expect(promise).rejects.toBeInstanceOf(CodexWireClosedError);
  });

  it('rejects requests made after the transport closed', async () => {
    const harness = makeHarness();
    harness.close();
    await expect(harness.wire.request('runTurn', {})).rejects.toBeInstanceOf(CodexWireClosedError);
  });
});
