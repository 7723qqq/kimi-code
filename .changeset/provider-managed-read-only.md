---
'@moonshot-ai/kimi-code': minor
---

Open managed providers read-only in `/provider`, and stop refusing the types its form cannot offer

Two kinds of record reach the edit form that its own field set does not
describe.

An Open Platform provider (`moonshot-cn`, `moonshot-ai`, `google-aistudio`,
`astron`) is written with `oauth` dropped, so the form's managed-provider check
— which looked only at `oauth` — let it be edited and renamed. The credential
then belonged to an id nothing refreshes, and the next `/login` or model refresh
re-added the original id beside the renamed copy, leaving two providers and two
sets of aliases. These records now open read-only, the way the OAuth account
already did, with the footer saying why. Editing them by hand in `config.toml`
is unchanged.

A provider stored with a type the form has no field for — `astron` under an id
that is not the platform's own — used to be refused with "unsupported protocol",
because the form would have rewritten the type to its first entry. The stored
type now joins the type field's cycle as an extra candidate: the record is
editable, and it keeps its transport unless you deliberately cycle away from it.
`kimi provider update` now carries the stored type through the same way instead
of casting it, so an untouched `--type` behaves identically on both front ends.
