---
"@moonshot-ai/kimi-code": patch
---

Plan, swarm and tower modes are now mutually exclusive: entering plan mode or dispatching AgentSwarm pauses open tower missions (worker spawns and merges on paused missions are refused), and tower init exits plan mode. Resume a paused mission with TowerMission status=active.
