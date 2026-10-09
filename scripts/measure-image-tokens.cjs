#!/usr/bin/env node
/**
 * Measure how a real OpenAI-compatible vision endpoint prices images, and
 * compare it with the DeepSeek vision formula implemented in
 * `packages/agent-core-v2/src/human/llm/tokens.ts` (`imageTokensFor`).
 *
 * The formula is a derivation from the DeepSeek family constants in
 * `packages/agent-core-v2/src/human/llm/modelFamily.ts` — not a reproduction of
 * a published spec. This script is the arbiter: run it against the real
 * endpoint and, if the numbers disagree, recalibrate both.
 *
 * Nothing here prints credentials. Provider/model/endpoint come from env:
 *   PROVIDER=deepseek  (a [providers.<name>] block in ~/.kimi-code/config.toml)
 *   MODEL=deepseek-v4-flash
 *   CONFIG=~/.kimi-code/config.toml
 *
 * Usage: node scripts/measure-image-tokens.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Jimp } = require('jimp');

const PROVIDER = process.env.PROVIDER ?? 'deepseek';
const MODEL = process.env.MODEL ?? 'deepseek-v4-flash';
const CONFIG =
  process.env.CONFIG ?? path.join(os.homedir(), '.kimi-code', 'config.toml');

const PRICING = {
  patchPx: 14,
  downsampleRatio: 3,
  scaleUpFloorPx: 544,
  tokenCap: 1024,
  fallbackTokens: 1024,
  lowDetailPx: 512,
};

function readProvider(name, configPath) {
  const text = fs.readFileSync(configPath, 'utf8');
  const block = new RegExp(`\\[providers\\.${name.replace(/\./g, '\\.')}\\]([\\s\\S]*?)(?=\\n\\[|$)`).exec(
    text,
  );
  if (block === null) throw new Error(`provider ${name} not found in ${configPath}`);
  const body = block[1];
  const apiKey = /api_key\s*=\s*"([^"]+)"/.exec(body);
  const baseUrl = /base_url\s*=\s*"([^"]+)"/.exec(body);
  if (apiKey === null) throw new Error(`provider ${name} has no api_key`);
  return { apiKey: apiKey[1], baseUrl: baseUrl === null ? undefined : baseUrl[1] };
}

/** Replica of `imageTokensFor` in human/llm/tokens.ts. Keep in sync with it. */
function imageTokensFor(pricing, dimensions) {
  const { patchPx, downsampleRatio, scaleUpFloorPx, tokenCap, fallbackTokens } = pricing;
  if (dimensions === undefined) return fallbackTokens;
  let width = dimensions.width;
  let height = dimensions.height;
  if (!(width > 0) || !(height > 0)) return fallbackTokens;
  const cell = patchPx * downsampleRatio;
  const shortEdge = Math.min(width, height);
  if (shortEdge < scaleUpFloorPx) {
    const scale = scaleUpFloorPx / shortEdge;
    width *= scale;
    height *= scale;
  }
  let cols = Math.max(1, Math.ceil(width / cell));
  let rows = Math.max(1, Math.ceil(height / cell));
  for (let step = 0; step < 8 && cols * rows > tokenCap; step += 1) {
    const scale = Math.sqrt(tokenCap / (cols * rows));
    width *= scale;
    height *= scale;
    cols = Math.max(1, Math.ceil(width / cell));
    rows = Math.max(1, Math.ceil(height / cell));
  }
  return Math.min(cols * rows, tokenCap);
}

async function pngDataUrl(width, height) {
  const image = new Jimp({ width, height, color: 0xffffffff });
  const buffer = await image.getBuffer('image/png');
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

async function ask(provider, body) {
  const root = (provider.baseUrl ?? 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const paths = ['/chat/completions', '/v1/chat/completions'];
  let missing = '';
  for (const path of paths) {
    const res = await fetch(`${root}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 404) {
      missing = `HTTP 404 at ${root}${path}`;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
  throw new Error(missing === '' ? 'no endpoint' : missing);
}

async function main() {
  const provider = readProvider(PROVIDER, CONFIG);
  console.log(`provider=${PROVIDER} model=${MODEL} base=${provider.baseUrl ?? 'default'}`);

  const textOnly = await ask(provider, {
    model: MODEL,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    max_tokens: 4,
    stream: false,
  });
  const baseline = textOnly.usage?.prompt_tokens ?? 0;
  console.log(`text-only prompt_tokens baseline = ${baseline}`);

  const sizes = [
    [200, 200],
    [512, 512],
    [1024, 1024],
    [1024, 512],
  ];
  console.log('\nsize       measured  minus-baseline  formula  delta');
  for (const [width, height] of sizes) {
    const url = await pngDataUrl(width, height);
    const reply = await ask(provider, {
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Reply with the single word: ok' },
            { type: 'image_url', image_url: { url } },
          ],
        },
      ],
      max_tokens: 4,
      stream: false,
    });
    const measured = reply.usage?.prompt_tokens ?? 0;
    const imagePortion = measured - baseline;
    const formula = imageTokensFor(PRICING, { width, height });
    console.log(
      `${`${width}x${height}`.padEnd(10)} ${String(measured).padEnd(9)} ${String(imagePortion).padEnd(
        16,
      )} ${String(formula).padEnd(8)} ${imagePortion - formula}`,
    );
  }
}

main().catch((error) => {
  console.error(`measurement failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
