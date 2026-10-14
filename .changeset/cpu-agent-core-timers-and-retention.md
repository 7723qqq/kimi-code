---
"@moonshot-ai/agent-core-v2": patch
---

Four fixes for work that grew with session size or outlived the request that started it.

**The antigravity transcript poller no longer outlives its request** (`human/llm/requester/bases/antigravity`). The 250 ms `setInterval` that syncs the `agy` transcript was cleared only when the child emitted `exit`/`error`, so a child that ignored SIGTERM left a 4 Hz synchronous-`fs` loop (stat/open/read/close) running for the rest of the process, and because the timer was never unref'd it also held the event loop open. It is now cleared on abort, unref'd, and cleared in a `finally` around the generator body so a consumer that abandons the stream cannot leak it either.

**The write-only tool-result map is gone** (`agent/loop/machine/tools.ts`). `extras` only ever had `set` called on it, was never pruned or cleared, and its only reader (`MachineEngine.toolExtras`) had no production consumer — so every completed tool call permanently retained up to 50 000 characters of output that compaction and undo could not release. The map, its mutation, the returned property, the interface member and the three test stubs that stubbed it are removed.

**`activeChain()` is a single pass** (`wire/tree/tree.ts`). The recursive walk scanned the entire entry list once per branch segment, so restoring a journal cost branch-depth × records over an append-only list that only grows across a session — and it re-ran on every engine attach, undo and retry. The chain is now built in one sweep over entries and segments, with an equivalence test against the previous algorithm.

**MCP stdio framing is no longer quadratic in one frame** (`mcpCore/client-stdio.ts`). Framing delegated to the SDK's `ReadBuffer`, which `Buffer.concat`s the accumulated buffer on every chunk and rescans it from offset 0, so a single large JSON-RPC line (a tool result with a big payload) copied and rescanned the whole prefix per chunk. The transport now buffers chunks and scans only from the previous offset, concatenating exactly once per completed frame.
