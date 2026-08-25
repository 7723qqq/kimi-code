/**
 * `codeRuntime` domain — the eval-mode worker entry source.
 *
 * The program-visible execution substrate, kept as a string so the worker can
 * be spawned with `eval: true` from the bundled package (a separate worker
 * file would need its own bundling story). Semantics ported from
 * deepseek-harness `code-runtime-worker-thread` (MIT): the program body runs
 * as a strict-mode async function (top-level `await` / `return` work), the
 * five `console.*` methods are captured in emission order under a shared
 * character budget, programs additionally receive the worker's own
 * `require`, and the completion value must be JSON-serializable —
 * `undefined` becomes an absent value, anything else un-serializable becomes
 * an `invalid-output` failure. Log lines stream to the host eagerly so
 * captured output survives a mid-run termination. The worker is a soft
 * isolation boundary, not a security sandbox.
 *
 * Wire protocol:
 *   host → worker: `{ type: 'run', code, maxOutputChars }`
 *   worker → host: `{ type: 'log', text }` × n, then `{ type: 'done', value?, error? }`
 */

export const CODE_WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads');
const { inspect } = require('node:util');

const INSPECT_OPTIONS = { depth: 4, maxArrayLength: 100, maxStringLength: 10_000 };
const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];

function makeLogBuffer(maxChars, sink) {
  let chars = 2; // JSON serialization of the empty logs array: []
  let entries = 0;
  let truncated = false;
  return {
    push(text) {
      if (truncated) return;
      const separator = entries > 0 ? 1 : 0;
      const available = maxChars - chars - separator;
      if (text.length <= available) {
        chars += text.length + separator;
        entries += 1;
        sink(text);
        return;
      }
      truncated = true;
      const prefix = text.slice(0, Math.max(0, available));
      if (prefix.length > 0) {
        chars += prefix.length + separator;
        entries += 1;
        sink(prefix);
      }
    },
    remaining() {
      return maxChars - chars;
    },
  };
}

function makeConsoleShim(logs) {
  const render = (args) => args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg, INSPECT_OPTIONS))).join(' ');
  const shim = {};
  for (const level of LEVELS) {
    shim[level] = (...args) => {
      logs.push(render(args));
    };
  }
  return shim;
}

function prepareCompletion(value, remaining) {
  if (value === undefined) return {};
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined || json.length > remaining) {
    return {
      error: {
        kind: json === undefined ? 'invalid-output' : 'output-limit',
        message: json === undefined
          ? 'program completion must be JSON-serializable'
          : 'program output exceeded the size limit',
      },
    };
  }
  try {
    return { value: JSON.parse(json) };
  } catch {
    return { error: { kind: 'invalid-output', message: 'program completion must be JSON-serializable' } };
  }
}

async function runOnce(msg) {
  const logs = makeLogBuffer(msg.maxOutputChars, (text) => parentPort.postMessage({ type: 'log', text }));
  const consoleShim = makeConsoleShim(logs);
  let done;
  try {
    // The async function constructor, reached through an instance because
    // AsyncFunction is not a global. The program body is strict mode.
    const AsyncFunction = (async () => {}).constructor;
    const fn = new AsyncFunction('console', 'require', "'use strict';\n" + msg.code);
    const value = await fn(consoleShim, require);
    done = { type: 'done', ...prepareCompletion(value, logs.remaining()) };
  } catch (error) {
    let message;
    try {
      message = error instanceof Error ? error.stack ?? error.message : String(error);
    } catch {
      message = 'program threw an unrenderable value';
    }
    done = { type: 'done', error: { kind: 'exception', message } };
  }
  parentPort.postMessage(done);
}

parentPort.on('message', (msg) => {
  if (msg && msg.type === 'run') {
    void runOnce(msg).catch((error) => {
      parentPort.postMessage({
        type: 'done',
        error: { kind: 'worker-error', message: String(error) },
      });
    });
  }
});
`;
