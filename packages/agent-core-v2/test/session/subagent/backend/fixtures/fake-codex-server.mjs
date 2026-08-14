// Minimal fake Codex app-server for tests: newline-delimited JSON-RPC over stdio.
// Env knobs:
//   FAKE_CODEX_CRASH_AFTER=<n> — exit(1) after the n-th runTurn
//   FAKE_CODEX_SLOW_MS=<ms>    — delay the turn/complete notification
import { createInterface } from 'node:readline';

const crashAfter = Number(process.env.FAKE_CODEX_CRASH_AFTER ?? '0');
const slowMs = Number(process.env.FAKE_CODEX_SLOW_MS ?? '0');
let runCount = 0;

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (line.trim().length === 0) return;
  handleMessage(JSON.parse(line));
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleMessage(message) {
  if (message.id === undefined) {
    // Notification (e.g. approval/respond) — nothing to answer.
    return;
  }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
    return;
  }
  if (message.method === 'startThread') {
    send({ jsonrpc: '2.0', id: message.id, result: { threadId: 'thread-1' } });
    return;
  }
  if (message.method === 'runTurn') {
    runCount += 1;
    if (crashAfter > 0 && runCount >= crashAfter) {
      process.exit(1);
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result: { turnId: 'turn-1' } });
    send({ jsonrpc: '2.0', method: 'turn/updated', params: { threadId: 'thread-1', turnId: 'turn-1', text: 'hello ' } });
    send({ jsonrpc: '2.0', method: 'turn/updated', params: { threadId: 'thread-1', turnId: 'turn-1', text: 'world' } });
    const complete = () => {
      send({ jsonrpc: '2.0', method: 'turn/complete', params: { threadId: 'thread-1', turnId: 'turn-1', status: 'completed' } });
    };
    if (slowMs > 0) {
      setTimeout(complete, slowMs);
    } else {
      complete();
    }
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, result: null });
}
