---
uid: e1e00006
id: kimi-code.engine.tools.team
parent: kimi-code.engine.tools
name: {zh: "团队与规划", en: "Team & planning"}
description:
  zh: >
      注册工具名：Team、EnterPlanMode、ExitPlanMode、TodoList。
      
  en: >
      Registered tool names: Team, EnterPlanMode, ExitPlanMode, TodoList.
      
revision: 67ba21094b198c6b3276a9e9650565e17f1d9d40
updated_at: "2026-10-03T15:32:22.802Z"
fingerprint: 7953640c3d441c9acf5cb0637edfdcd579bd0280015c168cc350c1186859345a
source:
  - path: "packages/kimi-agent/src/tools/team_tool.rs"
  - path: "packages/kimi-agent/src/tools/swarm_tool.rs"
  - path: "packages/kimi-agent/src/tools/plan_mode.rs"
  - path: "packages/kimi-agent/src/tools/todo_list.rs"
apis:
  - protocol: rpc
    path: "Team"
    description:
      zh: >
          多 agent 辩论与共识
          
      en: >
          Multi-agent debate and consensus
          
  - protocol: rpc
    path: "EnterPlanMode"
    description:
      zh: >
          进入计划模式
          
      en: >
          Enter planning mode
          
  - protocol: rpc
    path: "ExitPlanMode"
    description:
      zh: >
          携带计划退出计划模式
          
      en: >
          Exit planning mode with the plan
          
  - protocol: rpc
    path: "TodoList"
    description:
      zh: >
          持久化待办清单
          
      en: >
          Persisted todo list
          
---
