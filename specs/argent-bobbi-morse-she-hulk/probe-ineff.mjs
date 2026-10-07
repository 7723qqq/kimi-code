// How many tokens does one streamed part carry? The window is quantized by the
// part boundary, so this ratio caps what any client-side readout can achieve.
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
  let usage = null, usageAt = null, stopAt = null;
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
        const n = (d.text?.length ?? 0) + (d.thinking?.length ?? 0) + (d.partial_json?.length ?? 0);
        if (n > 0) parts.push({ at, chars: n });
      }
      if (ev.type === 'message_delta' && ev.usage) { usage = ev.usage; usageAt = at; }
      if (ev.type === 'message_stop') stopAt = at;
    }
  }
  return { parts, usage, usageAt, stopAt };
}

for (const [label, prompt, max] of [
  ['24 tok', 'Say only: hello world', 24],
  ['120 tok', 'Count 1 to 30 as digits.', 120],
  ['300 tok', 'Explain how a bicycle stays upright in about 150 words.', 300],
  ['900 tok', 'Explain in about 400 words how a thermos flask keeps tea hot.', 900],
]) {
  const r = await run(prompt, max);
  const out = r.usage?.output_tokens ?? 0;
  const win = r.parts.length > 1 ? r.parts.at(-1).at - r.parts[0].at : 0;
  const gaps = r.parts.slice(1).map((p, i) => p.at - r.parts[i].at);
  const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  console.log(
    `${label.padEnd(7)} | parts=${String(r.parts.length).padStart(3)} | tokens/part=${(out / r.parts.length).toFixed(1).padStart(5)} | window=${win.toFixed(0).padStart(5)}ms | mean part interval=${mean.toFixed(0).padStart(4)}ms | tail=${(r.usageAt - r.parts.at(-1).at).toFixed(0)}ms`,
  );
}
