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
      
revision: fc0aee5661e7c35635a3b8e21edce919532a4832
updated_at: "2026-09-30T20:33:58.103Z"
fingerprint: 48b406349dfa41cd9ef6a17f3877b02232ad5bf55f1c2ab7384b0eafe1955c80
source:
  - path: "packages/kimi-agent/src/injection/mod.rs"
  - path: "packages/kimi-agent/src/injection/state.rs"
---
