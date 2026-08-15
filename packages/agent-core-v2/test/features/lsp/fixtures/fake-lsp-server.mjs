// Minimal fake LSP server for tests: speaks Content-Length framing over stdio.
// Env knobs:
//   FAKE_LSP_CRASH_AFTER=<n>  — exit(1) after the n-th semantic query
//   FAKE_LSP_SLOW_MS=<ms>     — delay every semantic response
import { Buffer } from 'node:buffer';

const crashAfter = Number(process.env.FAKE_LSP_CRASH_AFTER ?? '0');
const slowMs = Number(process.env.FAKE_LSP_SLOW_MS ?? '0');
let queryCount = 0;

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (match === null) return;
    const length = Number(match[1]);
    if (buffer.byteLength < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
    buffer = buffer.subarray(headerEnd + 4 + length);
    handleMessage(JSON.parse(body));
  }
});

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(
    Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'utf8'), body]),
  );
}

function handleMessage(message) {
  if (message.method === 'exit') {
    process.exit(0);
    return;
  }
  if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'textDocument/didOpen') return;
  if (message.method === 'textDocument/didClose') return;
  if (message.method === '$/cancelRequest') return;
  if (message.id === undefined) return;

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        capabilities: {
          definitionProvider: true,
          referencesProvider: true,
          implementationProvider: true,
          hoverProvider: true,
        },
      },
    });
    return;
  }

  queryCount += 1;
  if (crashAfter > 0 && queryCount >= crashAfter) {
    process.exit(1);
    return;
  }

  const respond = (result) => {
    if (slowMs > 0) {
      setTimeout(() => {
        send({ jsonrpc: '2.0', id: message.id, result });
      }, slowMs);
    } else {
      send({ jsonrpc: '2.0', id: message.id, result });
    }
  };
  switch (message.method) {
    case 'textDocument/definition':
      respond({
        uri: 'file:///def.ts',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      });
      break;
    case 'textDocument/references':
      respond([
        {
          uri: 'file:///ref1.ts',
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
        },
      ]);
      break;
    case 'textDocument/implementation':
      respond({
        uri: 'file:///impl.ts',
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
      });
      break;
    case 'textDocument/hover':
      respond({ contents: { kind: 'plaintext', value: 'hover text' } });
      break;
    default:
      respond(null);
  }
}
