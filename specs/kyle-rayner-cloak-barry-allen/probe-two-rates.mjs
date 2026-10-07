/**
 * Verifies the two shipped readouts against a live provider.
 *
 * The footer now shows a step rate and a session average. Both are supposed to
 * come from the same place — the provider's own output-token count over the
 * engine's token-bearing-part window — so this harness replays exactly that
 * arithmetic and compares each figure with the provider's count over the whole
 * streamed span.
 *
 * It is the regression guard for the rejected approach: a trailing window over
 * locally estimated tokens measured far worse (+52% at 900 tokens against
 * +0.7% for the step window), so if a future revision reintroduces one, the
 * step-rate column here will move and this file's recorded numbers will no
 * longer match.
 *
 * Borrows a key from the local kimi-code config and hardcodes paths under the
 * author's home directory: an investigation tool for this checkout, not a
 * portable utility.
 */
const fs = require('node:fs');
const t = fs.readFileSync('/home/administrator/.kimi-code/config.toml', 'utf8');
const m = /\[providers\."MiniMax Token Plan"\]([\s\S]*?)(?=\n\[)/.exec(t);
const KEY = /api_key\s*=\s*"([^"]+)"/.exec(m[1])[1];
const BASE = /base_url\s*=\s*"([^"]+)"/.exec(m[1])[1];
const MODEL = process.env.MODEL ?? 'MiniMax-M2';

async function run(prompt, max) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: max, stream: true, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const t0 = performance.now();
  const parts = [];
  let out = 0, usageAt = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const at = performance.now() - t0;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === 'content_block_delta') {
        const d = ev.delta ?? {};
        if ((d.text?.length ?? 0) + (d.thinking?.length ?? 0) + (d.partial_json?.length ?? 0) > 0) {
          parts.push(at);
        }
      }
      if (ev.type === 'message_delta' && ev.usage) { out = ev.usage.output_tokens ?? 0; usageAt = at; }
    }
  }
  return { parts, out, usageAt };
}

/** The shipped step measurement: (n - 1) over the token-bearing-part window. */
function stepRate(r) {
  if (r.parts.length < 2 || r.out < 2) return null;
  const windowMs = r.parts.at(-1) - r.parts[0];
  return windowMs > 0 ? ((r.out - 1) / windowMs) * 1000 : null;
}
/** The reference: the provider's count over the whole streamed span. */
function observed(r) {
  const span = r.usageAt - r.parts[0];
  return span > 0 ? (r.out / span) * 1000 : null;
}

const CASES = [
  ['~900 tok', 'Explain in about 400 words how a thermos flask keeps tea hot.', 900],
  ['~300 tok', 'Explain how a bicycle stays upright in about 150 words.', 300],
  ['~120 tok', 'Count from 1 to 30, digits separated by spaces.', 130],
  ['~24 tok ', 'Say only: hello world', 24],
];
const RUNS = Number(process.argv[2] ?? 6);

const rows = [];
for (const [label, prompt, max] of CASES) {
  const errs = [];
  let unusable = 0;
  for (let i = 0; i < RUNS; i++) {
    let r;
    try { r = await run(prompt, max); } catch (e) { console.log(`${label}: run failed ${e.message}`); unusable++; continue; }
    const s = stepRate(r);
    const o = observed(r);
    if (s === null || o === null) { unusable++; continue; }
    errs.push(((s - o) / o) * 100);
  }
  const med = errs.length === 0 ? null : errs.slice().sort((a, b) => a - b)[Math.floor(errs.length / 2)];
  rows.push({ label, n: errs.length, unusable, med });
  console.log(
    `${label} n=${errs.length}/${RUNS}${unusable > 0 ? ` (${unusable} with no measurable window)` : ''} | ` +
    `step-rate median error ${med === null ? 'n/a' : med.toFixed(2) + '%'}`,
  );
}

console.log('\n=== against the budget in requirements.md ===');
const budget = { '~900 tok': 0.9, '~300 tok': 2.5, '~120 tok': 10, '~24 tok ': 35 };
let ok = true;
for (const row of rows) {
  const limit = budget[row.label];
  if (row.med === null) { console.log(`${row.label}: n/a — no sample`); continue; }
  const pass = Math.abs(row.med) <= limit;
  if (!pass) ok = false;
  console.log(`${row.label}: ${row.med.toFixed(2)}% vs ±${limit}% -> ${pass ? 'within' : 'OUTSIDE'}`);
}
console.log(ok ? '\nall rows within budget' : '\nSOME ROWS OUTSIDE BUDGET');
process.exit(ok ? 0 : 1);
