export const CODE_SHIM_SUBCOMMAND = '__run_code';

export const CODE_SHIM_SOURCE = String.raw`(function (require, process) {
const fs = require('node:fs');
const { inspect } = require('node:util');

const INSPECT_OPTIONS = { depth: 4, maxArrayLength: 100, maxStringLength: 10_000 };
const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];

function emit(message) {
  fs.writeSync(1, JSON.stringify(message) + '\n');
}

function makeLogBuffer(maxChars, sink) {
  let chars = 2;
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

function classifyException(error) {
  let message;
  try {
    message = error instanceof Error ? error.stack ?? error.message : String(error);
  } catch {
    message = 'program threw an unrenderable value';
  }
  const kind = typeof message === 'string' && /out of memory/i.test(message)
    ? 'memory-limit'
    : 'exception';
  return { type: 'done', error: { kind, message } };
}

function readStdinFully() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function runOnce(msg) {
  const logs = makeLogBuffer(msg.maxOutputChars, (text) => emit({ type: 'log', text }));
  const consoleShim = makeConsoleShim(logs);
  let done;
  try {
    const AsyncFunction = (async () => {}).constructor;
    const fn = new AsyncFunction('console', 'require', "'use strict';\n" + msg.code);
    const value = await fn(consoleShim, require);
    done = { type: 'done', ...prepareCompletion(value, logs.remaining()) };
  } catch (error) {
    done = classifyException(error);
  }
  emit(done);
}

async function main() {
  setInterval(() => {}, 2_147_483_647);
  if (typeof process.ppid === 'number') {
    const initialPpid = process.ppid;
    setInterval(() => {
      if (process.ppid !== initialPpid) process.exit(2);
    }, 2000).unref();
  }
  const raw = await readStdinFully();
  const msg = JSON.parse(raw);
  if (typeof msg.timeoutMs === 'number' && msg.timeoutMs > 0) {
    setTimeout(() => process.exit(2), msg.timeoutMs + 10_000).unref();
  }
  await runOnce(msg);
}

main().catch((error) => {
  try {
    emit({ type: 'done', error: { kind: 'worker-error', message: String(error) } });
  } catch {
    process.exit(1);
  }
});
})`;

export function runCodeShimMain(): void {
  // eslint-disable-next-line no-implied-eval
  const factory = new Function('require', 'process', `return ${CODE_SHIM_SOURCE}`) as (
    req: NodeRequire,
    proc: NodeJS.Process,
  ) => void;
  factory(require, process);
}
