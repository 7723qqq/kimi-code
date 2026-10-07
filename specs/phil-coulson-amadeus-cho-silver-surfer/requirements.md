# Requirements — The tok/s readout: what it measures, and where it lies

## Goal

The footer's `tok/s` readout is the only number in the product that answers "how fast is the model
generating". Today it is built from a decode window the provider may not report, smoothed by an EMA that
cannot tell "no information" from "a burst", and carried in state that nothing resets. This spec is an
audit first — the full data path with `file:line` citations — and then the minimum set of behavior
changes that make the readout an honest measurement of what its own docstring claims.

The deliverable is: (1) the audit, recorded here as evidence; (2) a decision on the four defects below;
(3) implementation tasks with runnable acceptance criteria.

## Audience

- **Users** reading the footer while a reply streams: the number must not read `4957 tok/s` on a cached
  or batched provider.
- **Maintainers** touching `apps/kimi-code/src/tui/utils/token-speed.ts` or the footer's stats row: the
  contract ("what is the denominator, when is a sample rejected, what resets it") must be written down
  where they will look.
- Out of scope as an audience: Web/vscode consumers of the same concept (see Boundaries).

## The current data path — audit

Nothing in this section is a proposal; every claim is a citation.

| Stage | Location | What happens |
| --- | --- | --- |
| Provider timing | `packages/agent-core-v2/src/llm-adapter/model/model-requester-impl.ts:228-241` | On each `llm.streaming.part`: the first part sets `firstChunkAt`; every later part adds `arrivedAt - lastResumeAt` to `serverDecodeMs`, then `lastResumeAt = Date.now()`. |
| Stream close | same file `:266-271` | On `llm.done`, adds `streamEndedAt - lastResumeAt` — closing the window after the last part. |
| Derived timings | same file `:405-414` | `firstTokenLatencyMs = firstChunkAt - requestStartedAt`; `streamDurationMs = outputEndedAt - firstChunkAt`; `serverDecodeMs` clamped to `>= 0`. |
| Transport | `packages/agent-core-v2/src/agent/loop/loopService.ts:1818-1822` (and `:1837-1841` for the other emit site) | Copies `step.timing` onto `turn.step.completed` as `llmFirstTokenLatencyMs`, `llmStreamDurationMs`, `llmServerDecodeMs`. |
| TUI event | `apps/kimi-code/src/tui/controllers/session-event-handler.ts:549` | `handleStepCompleted` calls `noteStepCacheStats(event.usage, event.llmStreamDurationMs, event.llmServerDecodeMs)`. |
| Denominator choice | `apps/kimi-code/src/tui/utils/token-speed.ts:53-65` | `pickDecodeMs`: prefers a positive `llmServerDecodeMs`; else accepts `llmStreamDurationMs >= 150` (`MIN_STREAM_WINDOW_MS`, `:43`); else `null`. |
| Per-step rate | same file `:71-80` | `computeSmoothedTokenSpeed`: rejects `outputTokens <= 0` / `decodeMs == null` / `<= 0` by returning `prev`; else `instant = outputTokens / decodeMs * 1000`, and `EMA_ALPHA = 0.4` blend (`:35`); `prev === null` initializes. |
| Per-step caller | `apps/kimi-code/src/tui/kimi-tui.ts:2591-2635` | `noteStepCacheStats` folds cache counters and the speed sample; on a non-null result stores `this.tokenSpeedEma` (`:317`) and patches `appState.tokenSpeed` (declared `apps/kimi-code/src/tui/types.ts:78`). |
| Render | `apps/kimi-code/src/tui/components/chrome/footer.ts:492-516` | Builds `speedText` only when `tokenSpeed > 0` (`:497-500`), via `t('tui.chrome.footer.tokenSpeed')` → `"{{speed}} tok/s"` (`apps/kimi-code/src/i18n/locales/en.ts:140`, `zh.ts:135`). |
| Formatting | `apps/kimi-code/src/tui/utils/session-stats.ts:127-130` | `formatTokenSpeed`: one decimal below 100, integer at and above; non-finite/`<= 0` renders `"0"`. |
| Slot + drop priority | `apps/kimi-code/src/tui/components/chrome/footer.ts:274-285` | `tok/s` sits in the `first token avg · tok/s` group with `priority: 3`; lower priority drops first. Documented order (`:231-232`): tool time → first-token avg → **tok/s** → LLM time → in/out → turns/steps. |
| Width fitting | `apps/kimi-code/src/tui/utils/session-stats.ts:141-...` | `fitSessionStatsText` drops the lowest-priority finite item until the text fits. |
| Tests | `apps/kimi-code/test/tui/utils/token-speed.test.ts` (89 lines), `apps/kimi-code/test/tui/components/chrome/footer-session-stats.test.ts:74,88` | Unit coverage of the threshold, the EMA blend, the burst-clamp convergence, and one render assertion (`107 tok/s`). |

Parallel implementation, different accounting — `apps/kimi-web/src/lib/sessionStats.ts:218-220`
(`tokensPerSecond = decodeTokens / decodeMs * 1000`, a session cumulative ratio, no EMA) and
`:239-242` (`formatTokensPerSecond`: one decimal below 10, integer above). Rendered by
`apps/kimi-web/src/components/chat/StatusPanel.vue`.

## Defects

### D1 — the EMA cannot tell "no information" from "a burst" (highest)

`pickDecodeMs` returns `llmServerDecodeMs` unconditionally when positive, with no plausibility check,
while the fallback path guards its window (`token-speed.ts:57-63`). But `serverDecodeMs` is itself a
sum of **inter-part arrival gaps** (`model-requester-impl.ts:234,269`), not a provider-measured decode
time despite the name and the docstring (`token-speed.ts:9-10`, "the provider-reported time it actually
spent generating"). For a provider that batches its response — and for any provider that does not report
a decode split, which the code's own comment (`kimi-tui.ts:2621-2625`) says covers Kimi and other
OpenAI-compatible endpoints — every part can arrive in one burst. Then `serverDecodeMs` is the
inter-arrival gap of a handful of events: tens of ms for hundreds of tokens.

The consequence is that the one guard written to stop this is bypassed on the path that actually runs,
and the burst is not discarded — it **initializes** the EMA (`:78`, `prev === null` returns `instant`
unsmoothed) or is folded in at weight 0.4. The test that pins this behavior
(`token-speed.test.ts:68-88`) asserts that a 30 ms burst sample is accepted and reads `> 3000`; it
documents the leak rather than preventing it.

### D2 — the EMA has no lifetime (medium)

`tokenSpeedEma` (`kimi-tui.ts:317`) has exactly two write sites (`:2629` inside the sample fold) and no
reset. Session-scoped state that is patched into `appState` — cache counters (`:2613-2618`),
`sessionStats` — is repopulated around it; a new session, a cleared session, or a replayed transcript can
leave the previous session's rate on screen, and a first step in a fresh session blends against a
stranger's history.

### D3 — the readout is dropped before the data it sits beside (low)

`tok/s` carries `priority: 3` (`footer.ts:283`), so it is dropped on narrowing terminals before LLM time
(4), input/output (5) and turn/step counts (6) — while the cache-hit rate and context readouts are
pinned at `Infinity`. The drop order is documented (`footer.ts:231-232`) and covered by
`footer-session-stats.test.ts:80-100`, so this is a deliberate ranking, not a bug; it is listed because
the ranking pre-dates several of the stats now competing with it, and the user of a `tok/s` readout is
usually mid-stream on a narrow pane.

### D4 — two products, two definitions, one name (low)

The TUI shows a step-level EMA of instantaneous rates while Web shows a session-cumulative ratio, under
the same `tok/s` label and with different rounding (`< 100` vs `< 10`). Both are defensible; neither is
marked as such. A user comparing the TUI footer with the web status panel sees two numbers and no way to
reconcile them.

## Requirements

- **R1 (D1)** A decode window is usable only if it is plausible for the token count it divides. A
  sub-threshold window must be rejected **on both selection paths**, and a rejected sample must leave the
  EMA unchanged rather than initialize or dilute it.
- **R2 (D1)** The rate for a step must remain within the bounds implied by the model's own throughput —
  the readout must never display a rate that the token/window pair cannot support. Whatever the guard is,
  it must be expressed in the same unit as the rate, not in an unrelated constant.
- **R3 (D2)** The readout's lifetime must be defined and stated: which events reset it, and what the
  footer shows immediately after a reset.
- **R4 (D3)** The drop priority of `tok/s` relative to the other stat items must be either kept and
  justified in the comment, or raised; the choice and the reason live in the code comment beside the
  priority.
- **R5 (D4)** The two `tok/s` readouts' definitions must be written down where each is implemented, and
  if they are to remain different, that difference must be explicit in both files. Changing one to match
  the other is a product decision — see design.md's option B.
- **R6** The audit's existing behaviors must not regress: the 150 ms fallback threshold boundary, the
  `prev`-preserving behavior for tool-only steps, and the `null`-vs-zero distinction all have pinned
  tests that must keep passing.

## Boundaries

**In scope**: `apps/kimi-code/src/tui/utils/token-speed.ts`, its caller `kimi-tui.ts:2591-2635`, the
footer slot and priority (`footer.ts:274-285`, `:492-516`), formatting
(`session-stats.ts:127-130`), and the docstrings that describe all of these. Test files for the above.

**Out of scope**:
- The upstream timing measurement (`model-requester-impl.ts`) — its inter-arrival definition is used by
  other consumers (first-token latency, session stats, the human timing plugin) and changing it is a
  separate, larger change. This spec treats `serverDecodeMs` as an input of unknown provenance.
- The Web/vscode readouts' code, beyond R5's documentation requirement.
- Adding a new status-line item, a config knob, or any new user-facing surface.
- `/status` and the transcript's per-step debug timing (`maybeShowDebugTiming`) — untouched.

## Open decision for the user

R1/R2 can be satisfied three ways with materially different consequences (reject implausible windows;
switch the denominator to a token-count-independent window; or stop smoothing and show a session
cumulative rate). They are laid out in design.md and passed to ExitSpecMode.
