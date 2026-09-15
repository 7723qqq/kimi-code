---
'@moonshot-ai/kimi-code': patch
---

Switch the managed usage payload to the platform's quota model (upstream #3787).

The platform `/usages` endpoint now serves per-window used ratios instead of absolute `used`/`limit` rows, so the old parser found nothing and `/usage` degraded to "No usage data available." for every signed-in user.

- `packages/oauth` parses the new `usages` map (`limit_5h` / `limit_7d` / `limit_month_total` / `limit_month_code`, each with `used_ratio` + `reset_time`) plus `boosterWallet`, and `getManagedUsage` returns `{ kind: 'ok', quota }`.
- The `/usage` panel builds its plan rows from whichever windows the backend served — `5h limit`, `Weekly limit`, `Monthly limit` — and the monthly row carries a `kimi X% · code Y%` breakdown line.
