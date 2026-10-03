---
uid: e0e00013
id: kimi-code.engine.core.injection.interruption-reminder
parent: kimi-code.engine.core.injection
name: {zh: "中断提醒", en: "Interruption reminder"}
description:
  zh: >
      上一回合被用户中断时，在下一回合步首注入一次性提醒；历史里已有就不再重复。
      
  en: >
      A one-shot reminder at the next turn's head when the previous turn was interrupted by the user; suppressed when history already carries one.
      
revision: 67ba21094b198c6b3276a9e9650565e17f1d9d40
updated_at: "2026-10-03T15:32:22.781Z"
fingerprint: fdee6b3e7e8a70860988a206eb7415953a14895f46e4007389b57a41147e06e5
source:
  - path: "packages/kimi-agent/src/injection/interruption_reminder.rs"
apis: []
---
