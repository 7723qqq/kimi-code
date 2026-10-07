/**
 * Real-provider measurement of the three tok/s implementations.
 *
 * One live stream, observed from the client, then each implementation's formula
 * applied to the SAME observations. This is the comparison that was missing:
 * the formulas were measured only against synthetic streams until now.
 *
 * Observed per SSE chunk:
 *   - arrival timestamp (monotonic)
 *   - whether the chunk carries generated content
 * Ground truth for "true decode rate" comes from the provider's own
 * usage.completion_tokens, divided by the interval the tokens were produced
 * over. That interval is only observable if the provider streams faithfully,
 * which is itself the subject of the measurement.
 */
const fs = require('node:fs');

function readProvider(name) {
  const t = fs.readFileSync('/home/administrator/.kimi-code/config.toml', 'utf8');
  const m = new RegExp(`\\[providers\\.${name}\\]([\\s\\S]*?)(?=\\n\\[)`).exec(t);
  if (m === null) throw new Error(`provider ${name} not found`);
  return {
    key: /api_key\s*=\s*"([^"]+)"/.exec(m[1])[1],
    base: /base_url\s*=\s*"([^"]+)"/.exec(m[1])[1],
  };
}

const PROVIDER = process.env.PROVIDER ?? 'deepseek';
const { key: KEY, base: BASE } = readProvider(PROVIDER);

async function runOnce({ model, prompt, maxTokens }) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const requestSentAt = performance.now();

  let firstPartAt = null;
  let lastPartAt = null;
  let lastAnyAt = null;
  let usageAt = null;
  let usage = null;
  let chars = 0;
  let chunks = 0;
  let contentChunks = 0;

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
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      const at = performance.now();
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      chunks++;
      lastAnyAt = at;
      const delta = ev.choices?.[0]?.delta ?? {};
      const text = delta.content ?? '';
      const reasoning = delta.reasoning_content ?? '';
      const toolArgs = delta.tool_calls?.[0]?.function?.arguments ?? '';
      const carries = text.length > 0 || reasoning.length > 0 || toolArgs.length > 0;
      if (carries) {
        contentChunks++;
        if (firstPartAt === null) firstPartAt = at;
        lastPartAt = at;
      }
      chars += text.length + reasoning.length + toolArgs.length;
      if (ev.usage) { usage = ev.usage; usageAt = at; }
    }
  }
  const streamEndedAt = performance.now();
  return { t0, requestSentAt, firstPartAt, lastPartAt, lastAnyAt, usageAt, streamEndedAt, usage, chunks, contentChunks, chars };
}

// --- the three formulas, transcribed from their sources ---
const dsh = (tokens, firstTok, completed) =>
  completed > firstTok ? tokens / ((completed - firstTok) / 1000) : null;

const mimoCompleted = (out, reason, startedAt, completedAt) => {
  const tokens = out + reason;
  return tokens === 0 ? null : tokens / ((completedAt - startedAt) / 1000);
};

const mine = (tokens, firstPart, lastPart) =>
  tokens > 1 && lastPart > firstPart ? (tokens - 1) / ((lastPart - firstPart) / 1000) : null;


(async () => {
  const model = process.argv[2] ?? 'deepseek-flash';
  const prompt = process.argv[3] ?? 'Write a 200-word description of how a thermos flask works. Plain prose, no lists.';
  const maxTokens = Number(process.argv[4] ?? 600);
  const runs = Number(process.argv[5] ?? 3);

  console.log(`provider: ${BASE}  model: ${model}  runs: ${runs}\n`);

  for (let i = 1; i <= runs; i++) {
    const r = await runOnce({ model, prompt, maxTokens });
    const u = r.usage;
    if (!u) { console.log(`run ${i}: no usage frame (stream_options ignored?)`); continue; }
    const outTok = u.completion_tokens ?? 0;
    const reasonTok = u.completion_tokens_details?.reasoning_tokens ?? 0;

    // Reference: the tokens over the window they were streamed in, measured
    // from the client. This is the best available "observed truth".
    const observed = mine(outTok, r.firstPartAt, r.lastPartAt);

    console.log(`--- run ${i} ---`);
    console.log(`  chunks=${r.chunks} content=${r.contentChunks} chars=${r.chars}`);
    console.log(`  TTFT(request->first part) ${(r.firstPartAt - r.requestSentAt).toFixed(0)}ms`);
    console.log(`  tail(last part->usage frame) ${(r.usageAt - r.lastPartAt).toFixed(0)}ms`);
    console.log(`  usage: prompt=${u.prompt_tokens} completion=${outTok} reasoning=${reasonTok}`);
    console.log(`  window(first part->last part) ${(r.lastPartAt - r.firstPartAt).toFixed(0)}ms`);
    console.log('');
    console.log(`  deepseek-harness  dsh=decodeTokens/(decodeMs/1e3), firstToken->assembled`);
    const a = dsh(outTok, r.firstPartAt, r.usageAt);
    console.log(`    = ${a === null ? 'null' : a.toFixed(1)} tok/s`);
    console.log(`  MiMo Code         tokens/(completed-started), started=step start`);
    const b = mimoCompleted(outTok, reasonTok, r.requestSentAt, r.usageAt);
    console.log(`    = ${b === null ? 'null' : b.toFixed(1)} tok/s`);
    console.log(`  this implementation (n-1)/(first part->last part)`);
    console.log(`    = ${observed === null ? 'null' : observed.toFixed(1)} tok/s`);
    console.log('');
    console.log(`  vs the observed window rate (${observed?.toFixed(1)}):`);
    console.log(`    dsh  ${a === null ? 'n/a' : ((a - observed) / observed * 100).toFixed(2) + '%'}`);
    console.log(`    mimo ${b === null ? 'n/a' : ((b - observed) / observed * 100).toFixed(2) + '%'}`);
    console.log('');
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
