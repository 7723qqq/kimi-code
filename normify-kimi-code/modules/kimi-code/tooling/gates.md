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
      
revision: 18c71cdd8583b337dd80efc94225c9033f341f42
updated_at: "2026-10-03T16:26:56.356Z"
fingerprint: 0bb8049621809f18a2d2b66ef209eb0ab0f9847c196cfbfca8ea404245a6d4f8
source:
  - path: "scripts/check-architecture-drift.mjs"
  - path: "scripts/scan-parity.mjs"
apis: []
---
