---
"@moonshot-ai/kap-server": patch
---

A transcript heal can no longer be starved by the churn it is healing. The debounce timer was refreshed on every terminal-turn operation without advancing its deadline, so a stream of such operations — exactly the condition that produces missing transcript segments — kept pushing the heal past the end of the burst, and the repair never ran. Each timer now carries a bounded deferral: refreshes stop once the entry has waited past a cap (8× the debounce), after which it fires on its existing deadline. Normal traffic keeps the full debounce; only a heal that has already waited its maximum stops being postponed.
