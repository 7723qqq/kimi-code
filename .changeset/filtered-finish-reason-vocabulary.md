---
'@moonshot-ai/kimi-code': patch
---

Provider safety stops now fail the turn with the filter notice instead of ending it as a normal completion: Anthropic's `refusal` stop reason and Google's safety vocabulary (`safety`, `recitation`, `blocklist`, `prohibited_content`, `spii`, `image_safety`) join OpenAI's `content_filter` in mapping to a filtered turn, matching the upstream adapters.
