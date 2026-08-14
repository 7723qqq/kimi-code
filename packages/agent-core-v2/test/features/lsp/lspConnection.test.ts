import { describe, expect, it } from 'vitest';

import { PassThrough } from 'node:stream';

import { MessageDecoder } from '#/features/lsp/framing';
import {
  LspConnection,
  LspServerError,
  LspTransportClosedError,
} from '#/features/lsp/lspConnection';
import type { IProcess } from '#/session/process/processRunner';
import type { LspMessage } from '#/features/lsp/protocol';

interface FakeProcessHarness {
  readonly process: IProcess;
  readonly requests: LspMessage[];
  readonly decoder: MessageDecoder;
  write(message: LspMessage): void;
  close(): void;
}

function makeFakeProcess(): FakeProcessHarness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const decoder = new MessageDecoder();
  const requests: LspMessage[] = [];
  stdin.on('data', (chunk: Buffer) => {
    for (const message of decoder.feed(chunk)) {
      requests.push(JSON.parse(message) as LspMessage);
    }
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
  return {
    process,
    requests,
    decoder,
    write: (message) => {
      const body = Buffer.from(JSON.stringify(message), 'utf8');
      stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'utf8'), body]));
    },
    close: () => stdout.end(),
  };
}

function lastRequest(harness: FakeProcessHarness): LspMessage {
  const request = harness.requests.at(-1);
  if (request === undefined) throw new Error('no request received');
  return request;
}

describe('LspConnection', () => {
  it('sends a request and resolves with the response', async () => {
    const harness = makeFakeProcess();
    const connection = new LspConnection(harness.process);
    const promise = connection.request('textDocument/definition', { position: { line: 0, character: 0 } });
    const request = lastRequest(harness);
    expect(request).toMatchObject({ jsonrpc: '2.0', method: 'textDocument/definition' });
    harness.write({ jsonrpc: '2.0', id: (request as { id: number }).id, result: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('rejects with LspServerError on an error response', async () => {
    const harness = makeFakeProcess();
    const connection = new LspConnection(harness.process);
    const promise = connection.request('textDocument/hover');
    const request = lastRequest(harness);
    harness.write({
      jsonrpc: '2.0',
      id: (request as { id: number }).id,
      error: { code: -32601, message: 'method not found' },
    });
    await expect(promise).rejects.toMatchObject({
      name: 'LspServerError',
      code: -32601,
    });
  });

  it('answers server-initiated requests through the handler', async () => {
    const harness = makeFakeProcess();
    const connection = new LspConnection(harness.process, async (method, params) => {
      if (method === 'workspace/configuration') return [null];
      throw new Error('nope');
    });
    harness.write({ jsonrpc: '2.0', id: 7, method: 'workspace/configuration', params: { items: [{ section: 'x' }] } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastRequest(harness)).toMatchObject({ id: 7, result: [null] });

    harness.write({ jsonrpc: '2.0', id: 8, method: 'workspace/applyEdit', params: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastRequest(harness)).toMatchObject({ id: 8, error: { code: -32603 } });
  });

  it('rejects pending requests when the transport closes', async () => {
    const harness = makeFakeProcess();
    const connection = new LspConnection(harness.process);
    const promise = connection.request('textDocument/hover');
    harness.close();
    await expect(promise).rejects.toBeInstanceOf(LspTransportClosedError);
  });

  it('rejects a request made after the transport closed', async () => {
    const harness = makeFakeProcess();
    const connection = new LspConnection(harness.process);
    harness.close();
    await expect(connection.request('textDocument/hover')).rejects.toBeInstanceOf(
      LspTransportClosedError,
    );
  });

  it('cancels and rejects a request when its signal aborts', async () => {
    const harness = makeFakeProcess();
    const connection = new LspConnection(harness.process);
    const controller = new AbortController();
    const promise = connection.request('textDocument/hover', undefined, controller.signal);
    const request = lastRequest(harness);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'LspRequestAbortedError' });
    expect(lastRequest(harness)).toMatchObject({
      method: '$/cancelRequest',
      params: { id: (request as { id: number }).id },
    });
  });

  it('ignores notifications', async () => {
    const harness = makeFakeProcess();
    const connection = new LspConnection(harness.process);
    const promise = connection.request('textDocument/hover');
    harness.write({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {} });
    const request = lastRequest(harness);
    harness.write({ jsonrpc: '2.0', id: (request as { id: number }).id, result: null });
    await expect(promise).resolves.toBeNull();
  });
});
