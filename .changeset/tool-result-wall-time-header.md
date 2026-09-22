---
'@moonshot-ai/kimi-code': patch
---

Tool results the model sees (and the session history persists) now open with a `Wall time: X.XXX seconds` line for Bash, Glob, Grep, WebSearch, FetchURL, Agent, AgentSwarm and every MCP tool, matching upstream; TaskList/TaskOutput/WaitFor/TaskStop reports and background-task notifications carry the same line, computed from the task's start and end times.
