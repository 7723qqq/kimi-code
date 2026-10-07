/**
 * Does inferring the window end improve short replies without hurting long
 * ones? The client sees parts in batches, so the last part it received does not
 * mark the end of decode — the next batch is still coming. Two candidate
 * readouts are compared against the observed truth (output_tokens over the
 * whole streamed span, which includes the tail the shipped window excludes):
 *
 *   A. shipped:  (n - 1) / (lastPart - firstPart)
 *   B. inferred: same, but the window end is extended to the moment the stream
 *      actually stopped producing: if the next part arrives, the window ends
 *      there; if the stream closes instead, the window ends at the last part
 *      plus the observed interval. This is only computable at stream end, which
 *      is exactly when the step completes.
 *
 * Reference for A and B: the provider's own token count over the full span,
 * i.e. what a stopwatch-and-token-count comparison would give.
 */
const fs = require('node:fs');
const t = fs.readFileSync('/home/administrator/.kimi-code/config.toml', 'utf8');
const m = /\[providers\."MiniMax Token Plan"\]([\s\S]*?)(?=\n\[)/.exec(t);
const KEY = /api_key\s*=\s*"([^"]+)"/.exec(m[1])[1];
const BASE = /base_url\s*=\s*"([^"]+)"/.exec(m[1])[1];

async function run(prompt, max) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'MiniMax-M2', max_tokens: max, stream: true, messages: [{ role: 'user', content: prompt }] }),
  });
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
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === 'content_block_delta') {
        const d = ev.delta ?? {};
        if ((d.text?.length ?? 0) + (d.thinking?.length ?? 0) > 0) parts.push(at);
      }
      if (ev.type === 'message_delta' && ev.usage) { out = ev.usage.output_tokens; usageAt = at; }
    }
  }
  if (parts.length < 2 || out < 2) return null;
  const first = parts[0];
  const last = parts.at(-1);
  const gaps = parts.slice(1).map((p, i) => p - parts[i]);
  const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const maxGap = Math.max(...gaps);
  // The decode that produced the last batch ran for about one batch interval
  // before the last part arrived; extend the window by that interval.
  const inferredEnd = last + meanGap;
  const window = last - first;
  const inferredWindow = inferredEnd - first;
  const truthSpan = usageAt - first; // includes the end-of-stream tail
  return {
    parts: parts.length,
    out,
    window,
    inferredWindow,
    tailMs: usageAt - last,
    meanGap,
    maxGap,
    A: (out - 1) / (window / 1000),
    B: (out - 1) / (inferredWindow / 1000),
    truth: out / (truthSpan / 1000),
  };
}

const cases = [
  ['24 tok', 'Say only: hello world', 24],
  ['60 tok', 'Describe a bicycle in about 60 words, plain prose.', 90],
  ['120 tok', 'Count from 1 to 30, digits separated by spaces.', 130],
  ['300 tok', 'Explain how a bicycle stays upright in about 150 words.', 300],
  ['900 tok', 'Explain in about 400 words how a thermos flask keeps tea hot.', 900],
];

const summary = [];
for (const [label, prompt, max] of cases) {
  const eA = [], eB = [];
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const r = await run(prompt, max);
    if (r === null) continue;
    n++;
    eA.push(((r.A - r.truth) / r.truth) * 100);
    eB.push(((r.B - r.truth) / r.truth) * 100);
  }
  const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  summary.push({ label, n, medA: med(eA), medB: med(eB) });
  console.log(
    `${label.padEnd(7)} n=${n} | shipped median err ${med(eA).toFixed(1).padStart(6)}% | inferred median err ${med(eB).toFixed(1).padStart(6)}%`,
  );
}
console.log('\nlabel    shipped   inferred');
for (const s of summary) console.log(`${s.label.padEnd(8)} ${s.medA.toFixed(1).padStart(7)}% ${s.medB.toFixed(1).padStart(8)}%`);
