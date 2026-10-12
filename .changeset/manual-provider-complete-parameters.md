---
'@moonshot-ai/kimi-code': minor
---

Let `/provider` and `kimi provider create/update` set every model field the engine stores

The manual provider path could set ten fields per model and four per provider,
while the config schema accepts more. A hand-added model could not declare a
per-model protocol override, a per-model endpoint, a beta-API flag or a
reasoning key, and a provider could not declare a credential environment
variable, its own default model, request headers or a provider-scoped
environment. All of them are reachable now, from the form and as flags:

- per model: `--protocol`, `--beta-api` / `--no-beta-api`, `--reasoning-key`,
  `--model-base-url`
- per provider: `--api-key-env`, `--provider-default-model`,
  `--custom-header k=v` (repeatable), `--env k=v` (repeatable), with
  `--clear-custom-headers` and `--clear-env` to drop the last two
- the form gained the matching fields, a `←`/`→` picker for the default
  thinking effort (it can only name an effort the row's ladder declares), and a
  notice when a model carries `overrides` — the layer the engine applies OVER
  every field the form owns, which the form cannot edit and could not previously
  even mention

Two states that the engine distinguishes but the form could not express are now
writable, and a third is documented as indistinguishable:

- `support_efforts = []` — a ladder that is declared and empty, which the engine
  reads differently from a missing key: it refuses to turn thinking off
  (`off-needs-offeffort`) where a missing key passes silently. Type `[]` in the
  Thinking-efforts field, or pass `--support-efforts '[]'`; a blank field still
  clears the key.
- `adaptive_thinking = false` — the budget-effort ladder. See the behaviour
  change below.
- `capabilities = []` deliberately got no UI: nothing downstream separates it
  from an omitted key, so the form's comment claiming otherwise was corrected
  rather than a second control added for an equivalent state.

`--clear-overrides` (and `Ctrl-X` in the row editor) drops a model's stored
`overrides`. They are applied after every other field, so a stale set used to
keep the runtime on the old values while the form showed the edited ones.

**Behaviour change**: `--no-adaptive-thinking` no longer deletes the stored
`adaptive_thinking` key — it writes `false`, which is a declaration of its own
(the engine reads it as the budget-effort ladder, whereas an omitted key falls
back to inference from the model name). Clearing the key is now
`--clear-adaptive-thinking`. In the form, `Space` on Adaptive thinking became a
three-position cycle — not declared → enabled → disabled → not declared — so the
key is no longer deleted by the second press; it is the third. The old behaviour
was not reachable through any other switch, so a script that relied on
`--no-adaptive-thinking` to remove the key must pass `--clear-adaptive-thinking`.
