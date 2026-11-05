---
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kimi-code": minor
---

Windows machines can now be remote environments. An SSH or custom-command target running Windows gets a PowerShell launch of the executor, Git Bash for the `Bash` tool, drive-path working directories, and its own path rules: `remoteBin` may be a bare name, an absolute Windows path, or a `~/` path, and tool arguments accept lexical drive forms such as `/c/work/file.txt`. Windows Docker targets are not supported.
