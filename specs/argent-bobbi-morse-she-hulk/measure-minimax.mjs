/**
 * Real-provider accuracy measurement for the footer's tok/s readout, against
 * MiniMax (Anthropic-compatible endpoint).
 *
 * The quantity being validated is the one the product shows: tokens over the
 * token-bearing-part window. The reference is the provider's own
 * `output_tokens` over the same window, so the comparison measures what the
 * client can observe — which is the honest ceiling for a client-side readout.
 *
 * A buffered delivery is the irreducible failure mode: the window then spans
 * delivery, not decode. Reported separately rather than averaged in.
 */
const fs = require('node:fs');

const t = fs.readFileSync('/home/administrator/.kimi-code/config.toml', 'utf8');
const m = /\[providers\."MiniMax Token Plan"\]([\s\S]*?)(?=\n\[)/.exec(t);
const KEY = /api_key\s*=\s*"([^"]+)"/.exec(m[1])[1];
const BASE = /base_url\s*=\s*"([^"]+)"/.exec(m[1])[1];
const MODEL = process.env.MODEL ?? 'MiniMax-M2';
const PROMPT =
  process.argv[2] ??
  'Explain, in about 400 words of plain prose without lists, how a thermos flask keeps tea hot.';
const MAX_TOKENS = Number(process.argv[3] ?? 900);
const RUNS = Number(process.argv[4] ?? 12);

async function runOnce() {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      stream: true,
      messages: [{ role: 'user', content: PROMPT }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const requestSentAt = performance.now();

  let firstPartAt = null;
  let lastPartAt = null;
  let lastAnyAt = null;
  let usageAt = null;
  let usage = null;
  let chunks = 0;
  let textChunks = 0;
  let thinkChunks = 0;
  let chars = 0;

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') continue;
      let ev;
      try {
        ev = JSON.parse(raw);
      } catch {
        continue;
      }
      const at = performance.now();
      chunks++;
      lastAnyAt = at;
      if (ev.type === 'message_delta' && ev.usage) {
        usage = ev.usage;
        usageAt = at;
      }
      if (ev.type === 'content_block_delta') {
        const d = ev.delta ?? {};
        const text = typeof d.text === 'string' ? d.text : '';
        const think = typeof d.thinking === 'string' ? d.thinking : '';
        const json = typeof d.partial_json === 'string' ? d.partial_json : '';
        if (text.length + think.length + json.length > 0) {
          if (text.length > 0) textChunks++;
          if (think.length > 0) thinkChunks++;
          if (firstPartAt === null) firstPartAt = at;
          lastPartAt = at;
          chars += text.length + think.length + json.length;
        }
      }
    }
  }
  const streamEndedAt = performance.now();
  return { requestSentAt, firstPartAt, lastPartAt, lastAnyAt, usageAt, streamEndedAt, usage, chunks, textChunks, thinkChunks, chars };
}

// The shipped readout, verbatim: (n - 1) over the token-bearing-part window.
const shipped = (tokens, first, last) =>
  tokens > 1 && first !== null && last !== null && last > first
    ? (tokens - 1) / ((last - first) / 1000)
    : null;
// The same window with the plain token count, for the numerator's effect alone.
const plainN = (tokens, first, last) =>
  tokens > 0 && first !== null && last !== null && last > first
    ? tokens / ((last - first) / 1000)
    : null;

const rows = [];
for (let i = 1; i <= RUNS; i++) {
  let r;
  try {
    r = await runOnce();
  } catch (e) {
    console.log(`run ${i}: FAILED ${e.message}`);
    continue;
  }
  const outTok = r.usage?.output_tokens ?? 0;
  const reportedWindowMs = r.lastPartAt === null ? null : r.lastPartAt - r.firstPartAt;
  // A delivery that compresses the stream into a fraction of the decode is the
  // irreducible case; flagged, not silently folded into the accuracy figure.
  const tailMs = r.usageAt === null || r.lastPartAt === null ? null : r.usageAt - r.lastPartAt;
  const totalMs = r.usageAt === null ? null : r.usageAt - r.firstPartAt;
  const bufferedShare = totalMs !== null && totalMs > 0 ? 1 - reportedWindowMs / totalMs : null;
  // Client-observed truth: the same tokens over the full streamed span, which
  // includes any tail the window legitimately excludes. Only meaningful when
  // the tail is small — otherwise there is no decode interval to compare to.
  const clientTruth = plainN(outTok, r.firstPartAt, r.usageAt);
  const rate = shipped(outTok, r.firstPartAt, r.lastPartAt);
  const diffPct =
    rate === null || clientTruth === null ? null : ((rate - clientTruth) / clientTruth) * 100;
  rows.push({
    i,
    outTok,
    reasonTok: r.usage?.output_tokens_details?.reasoning_tokens ?? 0,
    chunks: r.chunks,
    textChunks: r.textChunks,
    thinkChunks: r.thinkChunks,
    windowMs: reportedWindowMs,
    tailMs,
    rate,
    clientTruth,
    diffPct,
    bufferedShare,
  });
  console.log(
    `run ${String(i).padStart(2)} | out=${String(outTok).padStart(4)} tok | win=${String(Math.round(reportedWindowMs ?? -1)).padStart(6)}ms | tail=${String(Math.round(tailMs ?? -1)).padStart(7)}ms | shipped=${rate === null ? 'n/a' : rate.toFixed(1).padStart(7)} | obs=${clientTruth === null ? 'n/a' : clientTruth.toFixed(1).padStart(7)} | diff=${diffPct === null ? 'n/a' : diffPct.toFixed(1).padStart(6) + '%'} | text=${r.textChunks} think=${r.thinkChunks}`,
  );
}

const ok = rows.filter((r) => r.rate !== null && r.diffPct !== null);
if (ok.length > 0) {
  const within = (p) => ok.filter((r) => Math.abs(r.diffPct) <= p).length;
  const pcts = ok.map((r) => Math.abs(r.diffPct)).sort((a, b) => a - b);
  const mean = ok.reduce((a, r) => a + r.diffPct, 0) / ok.length;
  const rates = ok.map((r) => r.rate);
  const meanRate = rates.reduce((a, b) => a + b, 0) / rates.length;
  const sd = Math.sqrt(rates.reduce((a, b) => a + (b - meanRate) ** 2, 0) / rates.length);
  console.log('\n=== summary over ' + ok.length + ' measurable runs ===');
  console.log(`within ±5%   of the client-observed rate: ${within(5)}/${ok.length}`);
  console.log(`within ±10%  : ${within(10)}/${ok.length}`);
  console.log(`within ±20%  : ${within(20)}/${ok.length}`);
  console.log(`median |error|: ${pcts[Math.floor(pcts.length / 2)].toFixed(2)}%  max |error|: ${pcts.at(-1).toFixed(2)}%`);
  console.log(`mean signed error: ${mean.toFixed(2)}%`);
  console.log(`rate: mean ${meanRate.toFixed(1)} tok/s  range ${Math.min(...rates).toFixed(1)}-${Math.max(...rates).toFixed(1)}  CV ${(sd / meanRate).toFixed(3)}`);
  const buffered = rows.filter((r) => r.bufferedShare !== null && r.bufferedShare > 0.5);
  console.log(`runs with >50% of the stream span outside the window (buffered delivery): ${buffered.length}`);
}
