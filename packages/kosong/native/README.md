# `kosong/native` — Deprecated, not consumed

**Status: deprecated, kept for historical context, not referenced by any production code.**

## What this crate was

`packages/kosong/native` is a standalone Rust crate that mirrors `@moonshot-ai/kosong`'s LLM provider wire layer. It exposes three provider functions over napi-rs:

- `openai_chat` (OpenAI Chat Completions / Responses)
- `anthropic_chat` (Anthropic Messages)
- `google_genai_chat` (Google Generative AI)

The companion shim `index.js` only re-exports `init` and `version` (used to pick the platform-specific `.node` file). The three provider functions are **not called from any JS code** — verified by exhaustive search across `apps/` and `packages/`.

## Why it is here

Git history tells the story:

- `c7bf79768a chore: retire minidb + kosong-native; purge dead protocol event interfaces` — first retirement.
- `451bc4effa chore(klient,kosong): restore kosong/native crate; drop stray plan artifacts` — restored as part of an unrelated sweep; commit message: *"not in the cargo workspace nor referenced by production code, but deleted without intent; keep until deliberately retired"*.
- `0ff58c8558 feat(native-tools): …` — recently deleted `src/test_relay.rs` from this crate, evidence of incremental cleanup.

The current policy is: keep the source around for traceability, but no production code depends on it.

## Functional overlap with `@moonshot-ai/kimi-native-tools`

LLM streaming now lives in `@moonshot-ai/kimi-native-tools::llm_stream::run_llm_stream` (`packages/kimi-native-tools/src/llm_stream.rs`), which is wired up via `packages/kosong/src/providers/native-stream.ts`. Coverage:

| Provider | `kosong/native` | `kimi-native-tools::llm_stream` |
|---|---|---|
| OpenAI Responses | `openai_chat` (unused) | `provider: "openai-responses"` |
| OpenAI Chat Completions / Legacy | `openai_chat` (unused) | `provider: "openai-legacy"` |
| Anthropic Messages | `anthropic_chat` (unused) | `provider: "anthropic"` |
| Google Generative AI | `google_genai_chat` (unused) | **no equivalent** |

Three of the four are covered by the live LLM streaming path; Google GenAI is the only gap, and it has zero callers anyway.

## What to do

Two options if/when the team is ready to retire the crate:

1. **Retire the crate entirely** — delete `packages/kosong/native/` and drop it from any workspace globs. Saves a Cargo build step and a TS package on `bun install`.
2. **Restore the Google GenAI path** — port `google_genai_chat` into `kimi-native-tools` so the unused 30% of this crate becomes useful, then retire the rest.

Do not introduce new code that depends on `kosong/native` without confirming with `@moonshot-ai/kosong` first — the shim is intentionally incomplete (init/version only).

## Verifying

To re-confirm the dead-code claim:

```sh
# All TS code that touches this package
bun -e '
const fs = require("node:fs");
const path = require("path");
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "target" || e.name === ".worktrees") continue;
      walk(p, out);
    } else if (/\.ts$/.test(e.name)) out.push(p);
  }
}
const files = [];
walk("apps", files); walk("packages", files);
for (const f of files) {
  const t = fs.readFileSync(f, "utf8");
  for (const m of t.matchAll(/\b(anthropic_chat|google_genai_chat|openai_chat)\b/g)) {
    console.log(f, m[0]);
  }
}
'
```

Empty output ⇒ still no callers.
