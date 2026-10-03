---
uid: e1e00005
id: kimi-code.engine.tools.agent
parent: kimi-code.engine.tools
name: {zh: "Agent 工具族", en: "Agent tools"}
description:
  zh: >
      注册工具名：Agent、AgentSwarm、define_subagent、invoke_subagent、manage_subagents。
      
  en: >
      Registered tool names: Agent, AgentSwarm, define_subagent, invoke_subagent, manage_subagents.
      
revision: 18c71cdd8583b337dd80efc94225c9033f341f42
updated_at: "2026-10-03T16:26:56.338Z"
fingerprint: 949edefdfebc8b445f5206c3caf1705fb3b3440e9cb8dfdbe64d26d56f0031b1
source:
  - path: "packages/kimi-agent/src/tools/agent_tool.rs"
  - path: "packages/kimi-agent/src/tools/subagent_tools.rs"
  - path: "packages/kimi-agent/src/tools/select_tools.rs"
apis:
  - protocol: rpc
    path: "Agent"
    description:
      zh: >
          派生或寻址子代理
          
      en: >
          Spawn or address a subagent
          
  - protocol: rpc
    path: "AgentSwarm"
    description:
      zh: >
          并行 agent 集群
          
      en: >
          Parallel agent swarm
          
  - protocol: rpc
    path: "define_subagent"
    description:
      zh: >
          注册子代理画像
          
      en: >
          Register subagent profiles
          
  - protocol: rpc
    path: "invoke_subagent"
    description:
      zh: >
          调用已注册子代理
          
      en: >
          Invoke a registered subagent
          
  - protocol: rpc
    path: "manage_subagents"
    description:
      zh: >
          管理已注册子代理
          
      en: >
          Manage registered subagents
          
---
