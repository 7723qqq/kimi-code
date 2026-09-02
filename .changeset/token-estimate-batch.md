---
"@moonshot-ai/agent-core-v2": minor
---

Route native token estimation through a single batched napi call where it is safe to do so: `_base/native-tools.ts` adds `tryNativeEstimateTokensBatch`, and `kosong/contract/tokens.ts` wires it into the stateless `estimateTokensForTools` (batch-first, falling back to per-item JS on failure). `estimateTokensForMessages` keeps its existing per-item WeakMap cache path unchanged (media parts still use the JS constant). Numeric semantics are identical across all three modes (native batch, native per-item, JS): ASCII `ceil(n/4)` + non-ASCII code-point count. `usage-tokens.test.ts` now has 17 cases, adding cache-hit and routing assertions plus mixed-script corpora verifying batch ≡ per-item and the FORCE_JS escape hatch. Verified: engine contract 67 + related suites all green, typecheck, oxlint 0 errors, no violations in comment-free zones.
