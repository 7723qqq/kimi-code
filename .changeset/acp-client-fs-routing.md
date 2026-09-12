---
'@moonshot-ai/kimi-code': minor
---

Let an ACP client that virtualizes the filesystem or hosts a terminal own Read/Write/Bash execution. When `initialize` declares `fs.readTextFile` / `fs.writeTextFile`, the ACP session host reports those tools as host-owned and executes them over the reverse RPCs (`fs/read_text_file` / `fs/write_text_file`), so the agent edits the client's virtual filesystem; when it declares `terminal`, the Bash tool runs on the client's PTY (`terminal/create` → `wait_for_exit` → `output` → `release`, with a fallback to native Bash if the terminal cannot be created). The routing respects the engine's existing veto → permission → stale gates (a `Write` still asks for approval first) and falls back to native execution when the client advertises no capability. The `HostCallbacks` trait gains a default `owns_tool` seam that the callbacks decorators forward.
