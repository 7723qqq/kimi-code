---
"@moonshot-ai/kimi-code": patch
---

Report the footer's decode rate (`tok/s`) on a clock that survives the session boundary. The two
timestamps that bracket a step's decode window were sampled from a monotonic clock and then shipped
to other processes, where they were read as wall-clock values; a session resumed from history could
therefore mix two clock domains into one average. They are now epoch milliseconds and carry that
claim explicitly, so the web status panel can check them against the frame that delivered them and
drop a step whose window does not belong to it. Both readouts also count the same tokens now
(`n - 1`, the number of inter-token gaps the window spans), so the CLI footer and the web panel
agree on a given reply instead of differing by one token per step.
