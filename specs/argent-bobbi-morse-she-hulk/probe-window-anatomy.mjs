// Where does the shipped window sit relative to the true decode, and what does
// the residual consist of? Splits the error into its two components.
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
  if (parts.length < 2) return null;
  const gaps = parts.slice(1).map((p, i) => p - parts[i]);
  const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const window = parts.at(-1) - parts[0];
  return {
    firstGap: gaps[0],
    meanGap,
    window,
    tail: usageAt - parts.at(-1),
    out,
    // The window starts one batch-interval after decode began (the first part
    // carries tokens produced before it) and ends one batch-interval before
    // decode ended. Both boundaries quantize by the batch interval.
    hypothesis: meanGap / window,
  };
}

for (const [label, prompt, max] of [
  ['24 tok', 'Say only: hello world', 24],
  ['300 tok', 'Explain how a bicycle stays upright in about 150 words.', 300],
  ['900 tok', 'Explain in about 400 words how a thermos flask keeps tea hot.', 900],
]) {
  console.log(`\n=== ${label} ===`);
  for (let i = 0; i < 3; i++) {
    const r = await run(prompt, max);
    if (r === null) { console.log('  insufficient parts'); continue; }
    console.log(
      `  tokens=${String(r.out).padStart(4)} firstGap=${r.firstGap.toFixed(0).padStart(4)}ms meanGap=${r.meanGap.toFixed(0).padStart(4)}ms window=${r.window.toFixed(0).padStart(5)}ms tail=${r.tail.toFixed(0).padStart(4)}ms | meanGap/window=${(r.hypothesis * 100).toFixed(1)}%`,
    );
  }
}
