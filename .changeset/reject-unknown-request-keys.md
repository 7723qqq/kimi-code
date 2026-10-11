---
"@moonshot-ai/kimi-code": patch
---

Reject an unrecognized key at every request boundary instead of dropping it silently: route bodies and querystrings beyond the configuration patch now return `40001` naming the key, where a misspelled field used to come back as `code: 0` with the value discarded. Also rejects a negative TTL — `SET k v EX abc` answered `+OK` and stored the key forever, and a programmatic `ttl: -1` dropped the value on the next read — and reports a failure when an interaction write targets an unknown, foreign, or already-resolved id, which used to resolve successfully and leave the interaction pending so a caller could not tell "approved" from "nothing happened".
