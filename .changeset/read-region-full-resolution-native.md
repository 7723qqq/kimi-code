---
'@moonshot-ai/kimi-code': patch
---

Honor the Read tool's `region` and `full_resolution` arguments on the native engine. An image read is now delivered to the model as media on every engine path, `region` returns the requested crop (at native resolution when combined with `full_resolution`) and `full_resolution` sends the original bytes, with the v2 decode/byte-budget gates and the matching `<system>` media notes. Previously both arguments were silently handed back to the host, so standalone sessions could not zoom into an image.
