---
"@moonshot-ai/kimi-code": patch
---

Stop the thinking block from showing the same reasoning twice across tool steps. A tool call and its result only pushed the pending reasoning into the component (`flushNow`) without settling it or clearing the buffer, so the next step's reasoning kept appending to the same block and the same draft. Because consecutive steps reason about a task the tool result has not changed yet, the appended text is the same text — the block rendered it twice, which is why it looked identical every time. Both boundaries now finalize the live text instead, so each step's reasoning is its own block.
