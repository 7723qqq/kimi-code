---
uid: "70e00001"
id: kimi-code.tooling.gates
parent: kimi-code.tooling
name: {zh: "质量门禁", en: "Quality gates"}
description:
  zh: >
      CI 与 pre-commit 门禁：架构漂移指纹、locale 键一致、Rust-TS parity、上游 delta 分诊。
      
  en: >
      CI and pre-commit gates: architecture drift fingerprints, locale-key consistency, Rust-TS parity, upstream delta triage.
      
revision: 435e51cd310eb9df90ddb522a8d245cae01e86cf
updated_at: "2026-09-30T19:09:30.073Z"
fingerprint: a403772227aa62d7b6adc9545dfcaeff7e817eebe1081d27ce855391509a10b4
source:
  - path: "scripts/check-architecture-drift.mjs"
  - path: "scripts/scan-parity.mjs"
apis: []
---
