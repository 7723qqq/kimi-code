---
"@moonshot-ai/kimi-code": minor
---

Converge the Rust engine's native grep fallback surface in `packages/kimi-agent`: the `type`, `include_ignored`, and `multiline` parameters no longer fall back to the external ripgrep process, so the zero-JS-loop path stays fully native for these common options.

- `type` → rg `--type`: a new `src/tools/grep_types.rs` transcribes the 217-entry type→basename-glob table from rg 15.0.0's `--type-list` (pure data, no cross-crate dependency) as a fast path; unknown type names fall back to the host, which still honors `.ripgreprc` custom types and any rg version.
- `include_ignored` → rg `--no-ignore`: the WalkBuilder flips its gitignore/global/exclude/parents switches; VCS directories and sensitive files remain force-excluded.
- `multiline` → rg `-U --multiline-dotall`: `dot_matches_new_line` plus a whole-file buffered scan path (enabled only when multiline=true, keeping the 4MiB cap and binary skip); cross-line hits report line numbers per physical line, `--count-matches` counts matches, and `-C`/`--` clustering matches the single-line path.

The `grep()` fallback surface shrinks to: pattern parameter shape, invalid output_mode, glob (including type glob) build failure, path missing or out of bounds, malformed argument types (which fall back to the host's zod validation), and unknown type names. Adds engine tests covering type/include_ignored/multiline parity, deterministic ordering, and fallback routing, plus a reconciliation test against `rg --type-list` (all 217 types equal; skipped when rg is unavailable); a byte-for-byte alignment self-check against real rg 15.0.0 passes all 8 scenarios. All gates green: clippy/fmt exit 0, cargo test lib + integration, kimi-agent vitest, agent-core-v2 contract, zero-js-loop OK; bench-tool-path engine grep median keeps pace with (and typically beats) host ripgrep, no regression.
