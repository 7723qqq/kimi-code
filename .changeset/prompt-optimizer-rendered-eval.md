---
"@moonshot-ai/agent-core-v2": patch
---

The prompt optimizer evaluates the prompt a session actually receives, not the `system.md` template.

`scripts/prompt-optimizer` used to parse the template file and benchmark its raw text, so every measurement described a prompt nobody is ever given: the placeholders were still there, the profile-specific sections were not applied, and a DeepSeek session's reminder was invisible. A new render layer (`src/rendered-prompt.ts`) calls the production renderer directly, with no DI runtime and no user home file, and returns the rendered system text plus the adaptation reminder, the source hash, the token counts, the contract channels and the renderer warnings.

- `--profile full | minimal | deepseek-adapted` selects what is rendered, and it must agree with `--model`: a full-shape family for `full`, a minimal-shape family for `minimal`, and a minimal-shape family with a curated adaptation for `deepseek-adapted`. A mismatch is a named `profile_model_mismatch` naming both values, never a silent fallback to the template. A bare `minimal` profile is refused when it would leave a core rule with no delivery channel.
- The runner sends the reminder as a `user` `<system-reminder>` prelude and records that placement, and each result carries the profile, source hash, fixture summary, delivery counts and tokens. The benchmark cases are mapped to the six contract ids with load-time validation, and the tool-behavior cases declare `availableTools` so their `tool-called` / `tool-not-called` checks exercise real tool calls instead of matching strings.
- **Sending the user's own global instructions is opt-in.** `--actual-global` accepts one authorized path and fails closed for anything else; the content is sent to the configured provider, never written to a report, a log, or the repository, and the fixture summary records only that an actual global file was used and how large it was.
- The report now has a schema with `model`, `profile`, `sourceHash`, `fixtureSummary`, per-contract coverage, per-case results, token counts and classified API errors (`model_failure` versus `provider_failure`). A dry run, a renderer warning, missing credentials or a provider failure all produce `effectivenessVerdict: "unavailable"` with the blocker named, and a contract-coverage gap fails the run instead of producing a report — so no result can claim an effect it did not measure. Reports contain no credentials and no prompt body.
- `--compare` with prune variants remains the only raw-template experiment and is labelled as such in its output.
