// Golden generator: run v2's REAL `acp-server/src/events-map.ts` under bun and
// record its output for a fixed probe set. The Rust suite
// (`src/acp/events_map_golden.rs`) reads the result and must match it case for
// case, so equivalence with the reference is measured, not argued.
//
//   bun scripts/gen-acp-golden.mjs           # re-record from .tmp/v2-ref
//   bun scripts/gen-acp-golden.mjs --check X # diff a candidate against golden
//
// The v2 checkout lives at the repo-root `.tmp/v2-ref` (the fork's retired
// reference, the only one carrying `acp-server`). When that is missing the
// script says so rather than silently recording nothing — a golden file that
// can be regenerated from thin air is not a golden file.
import { plugin } from 'bun';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const REPO = resolve(PKG, '../..');

const V2_EVENTS_MAP = resolve(
  REPO,
  '.tmp/v2-ref/packages/acp-server/src/events-map.ts',
);
const GOLDEN = resolve(PKG, 'test/acp-golden.json');

if (!existsSync(V2_EVENTS_MAP)) {
  console.error(
    `v2 reference not found: ${V2_EVENTS_MAP}\n` +
      'It carries acp-server, which upstream/main does not. Point .tmp/v2-ref ' +
      'at a checkout that has the retired packages, then re-run.',
  );
  process.exit(2);
}

const STUB = `
function boom(name) { throw new Error('shimmed export called: ' + name); }
export const compressBase64ForModel = () => boom('compressBase64ForModel');
export const buildImageCompressionCaption = () => boom('buildImageCompressionCaption');
export const parseImageDataUrl = () => boom('parseImageDataUrl');
export const persistOriginalImage = () => boom('persistOriginalImage');
export const createCompactionSummaryMessage = () => boom('createCompactionSummaryMessage');
export const COMPACTION_SUMMARY_PREFIX = '';
export default {};
`;

plugin({
  name: 'v2-acp-shim',
  setup(build) {
    for (const spec of [
      '@moonshot-ai/agent-core-v2',
      '@moonshot-ai/agent-core-v2/events',
      '@moonshot-ai/agent-core-v2/tool/toolInputDisplay',
      '@moonshot-ai/agent-core-v2/tool/toolContract',
      '@agentclientprotocol/sdk',
    ]) {
      build.module(spec, () => ({ contents: STUB, loader: 'ts' }));
    }
  },
});

const v2 = await import(pathToFileURL(V2_EVENTS_MAP).href);

if (process.argv.includes('--check')) {
  // Compare a Rust-produced candidate against the recorded golden.
  const actual = readFileSync(process.argv[process.argv.indexOf('--check') + 1], 'utf8');
  const expected = readFileSync(GOLDEN, 'utf8');
  const a = JSON.parse(actual);
  const e = JSON.parse(expected);
  let bad = 0;
  for (const key of Object.keys(e)) {
    const x = JSON.stringify(e[key]);
    const y = JSON.stringify(a[key]);
    if (x !== y) {
      bad++;
      console.log(`MISMATCH ${key}\n  v2:   ${x}\n  rust: ${y}`);
    }
  }
  for (const key of Object.keys(a)) {
    if (!(key in e)) {
      bad++;
      console.log(`EXTRA in rust: ${key} = ${JSON.stringify(a[key])}`);
    }
  }
  console.log(
    bad === 0
      ? `OK: ${Object.keys(e).length} cases byte-identical to v2`
      : `${bad} mismatch(es)`,
  );
  process.exit(bad === 0 ? 0 : 1);
}

// 鈹€鈹€ Record 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const todo = (items) => v2.todoListToSessionUpdate('s1', 1, items);
const golden = {
  // usage_update
  usage_basic: v2.usageUpdateNotification('s1', 1234, 262144),
  usage_zero_used: v2.usageUpdateNotification('s1', 0, 128000),
  usage_zero_both: v2.usageUpdateNotification('s1', 0, 0),
  // session_info_update
  session_info_title: v2.sessionInfoUpdateNotification('s1', 'My title'),
  session_info_empty: v2.sessionInfoUpdateNotification('s1', ''),
  session_info_null: v2.sessionInfoUpdateNotification('s1', null),
  // available_commands_update
  available_empty: v2.availableCommandsUpdateNotification('s1', []),
  available_one: v2.availableCommandsUpdateNotification('s1', [
    { name: 'help', description: 'Show available ACP commands' },
  ]),
  available_with_input: v2.availableCommandsUpdateNotification('s1', [
    { name: 'compact', description: 'Compact the conversation context', input: { hint: '<optional>' } },
  ]),
  // plan
  plan_empty: todo([]),
  plan_one: todo([{ title: 'first', status: 'pending' }]),
  plan_status_done: todo([{ title: 'a', status: 'done' }]),
  plan_status_completed: todo([{ title: 'b', status: 'completed' }]),
  plan_status_in_progress: todo([{ title: 'c', status: 'in_progress' }]),
  plan_status_pending: todo([{ title: 'd', status: 'pending' }]),
  plan_status_unknown: todo([{ title: 'e', status: 'weird' }]),
  plan_status_empty: todo([{ title: 'f', status: '' }]),
  plan_multi: todo([
    { title: 'one', status: 'done' },
    { title: 'two', status: 'in_progress' },
    { title: 'three', status: 'nonsense' },
  ]),
  plan_empty_title: todo([{ title: '', status: 'pending' }]),
  // planFromDisplayBlock gating
  plan_from_block_todo: v2.planFromDisplayBlock('s1', 1, {
    kind: 'todo_list',
    items: [{ title: 'x', status: 'done' }],
  }),
  plan_from_block_diff: v2.planFromDisplayBlock('s1', 1, {
    kind: 'diff',
    path: '/a',
    before: 'x',
    after: 'y',
  }),
  plan_from_block_generic: v2.planFromDisplayBlock('s1', 1, {
    kind: 'generic',
    summary: 's',
  }),
  // infer_tool_kind (already mapped in Rust 鈥?regression guard)
  toolkind_read: v2.inferToolKind('Read'),
  toolkind_bash: v2.inferToolKind('Bash'),
  toolkind_unknown: v2.inferToolKind('NoSuchTool'),
  // acp_tool_call_id namespacing
  toolcall_id: v2.acpToolCallId(7, 'call-1'),
  toolcall_id_zero: v2.acpToolCallId(0, 'call-1'),
  // turn_end_reason mapping
  stopreason_completed: v2.turnEndReasonToStopReason('completed'),
  stopreason_cancelled: v2.turnEndReasonToStopReason('cancelled'),
  stopreason_failed: v2.turnEndReasonToStopReason('failed'),
  stopreason_blocked: v2.turnEndReasonToStopReason('blocked'),
  stopreason_unknown: v2.turnEndReasonToStopReason('something_else'),
};

writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + '\n', 'utf8');
console.log(`wrote ${Object.keys(golden).length} golden cases -> ${GOLDEN}`);
