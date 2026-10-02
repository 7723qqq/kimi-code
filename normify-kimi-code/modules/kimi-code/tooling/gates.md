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
      
revision: e3b4951aa50a8b3474258307ac372a2b743bd40f
updated_at: "2026-10-02T14:45:23.038Z"
fingerprint: d00c3b5cbb041fb176b09e06066fedb5b11307ccfd9413e64e54233d7fbf9b65
source:
  - path: "scripts/check-architecture-drift.mjs"
  - path: "scripts/scan-parity.mjs"
apis: []
---
