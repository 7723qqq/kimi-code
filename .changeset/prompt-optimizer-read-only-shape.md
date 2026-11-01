---
"@moonshot-ai/kimi-code": patch
---

`bench:prompt --read-only` measures the prompt shape an explore or plan agent actually receives: `delivering-work-read-only.md` instead of the full change-work section, and no coding guidance. Before this, `bench` could only render the full shape, so its verdict said nothing about the two read-only profiles. The report carries `Shape:` and a `sourceHash` that includes the shape, so a full-shape result can no longer be read as evidence about the read-only one.
