---
uid: e0e00010
id: kimi-code.engine.core.injection
parent: kimi-code.engine.core
name: {zh: "回合注入层", en: "Turn injections"}
description:
  zh: >
      把状态、模式与技能折成 <system-reminder> 注入到步首。注册表是唯一入口，DomainValueSource 是它读领域值的唯一契约。
      
  en: >
      Folds state, modes and skills into <system-reminder> at each step head. The registry is the single entry point, and DomainValueSource the one contract it reads domain values through.
      
revision: 18c71cdd8583b337dd80efc94225c9033f341f42
updated_at: "2026-10-03T16:26:56.317Z"
fingerprint: 33659a35600276f0bb60118b664288928a4d44aed8fe5f2db689ac6a0620fda0
source:
  - path: "packages/kimi-agent/src/injection/mod.rs"
  - path: "packages/kimi-agent/src/injection/state.rs"
---
