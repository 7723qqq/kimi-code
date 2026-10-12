---
'@moonshot-ai/kimi-code': minor
---

Let the manual provider form set thinking efforts, capabilities and context sub-limits

`/provider` → add/edit and `kimi provider create/update` collected three
fields per model — the id, the context size and a display name — while the
engine accepted seven more. A hand-added model therefore always declared
`capabilities = [ "tool_use", "thinking" ]` and nothing else: a multimodal
gateway model could not be given `image_in` without editing `config.toml` by
hand, and the request was then refused with "the current model does not support
image input" rather than "you did not declare the capability". A model that
declares thinking efforts but no off-effort could not be turned off at all from
the UI, because there was no field to declare one.

The row editor now carries `max_input_tokens`, `max_output_tokens`,
`capabilities`, `support_efforts`, `default_effort`, `off_effort` and
`adaptive_thinking`, and the CLI mirrors each one as a flag (`--max-input-size`,
`--capabilities`, `--support-efforts`, `--default-effort`, `--off-effort`,
`--adaptive-thinking` / `--no-adaptive-thinking`).

Three semantics are enforced rather than left to the config file:
`support_efforts` keeps the order you type (the default effort is the middle
entry and the persistence ceiling is derived from the index, so sorting it would
change behaviour); a default effort outside `support_efforts` is refused,
because the SDK and the engine both drop it silently; and a capability name
outside the eight the engine knows is refused instead of being written as an
inert label.

Blank and absent are different states. A field left blank clears the key; a
field the form does not present — anything set only in `config.toml`, such as
`overrides` or `reasoning_key` — is left exactly as it was, so editing a row
does not quietly drop it.

**Behaviour change**: a newly created model alias no longer writes
`adaptive_thinking = true`. Forcing it made every hand-added model declare
adaptive thinking, which is wrong for the budget-style gateways this path
exists for; omitting it lets the engine infer from the model name, which is
what the Anthropic profile already does. The default
`capabilities = [ "tool_use", "thinking" ]` is unchanged, since a hand-added
model name is usually one the engine cannot classify on its own.
