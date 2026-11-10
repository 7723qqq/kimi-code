List the versions this session recorded for a file before it was overwritten.

Write and Edit keep a record of the content they replace. This tool reads that record for one path and answers who replaced it, when, and in which session or subagent: each line carries the time, the tool that wrote, the size, a short content hash, and the agent that did it. Versions come newest first; index 1 is the most recent overwrite.

It never returns the recorded content. To put a version back, the user runs `kimi snapshot restore <path> --previous` (or `--hash <sha|id>` for a specific one).
