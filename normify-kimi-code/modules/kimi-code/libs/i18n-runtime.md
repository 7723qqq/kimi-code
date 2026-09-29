---
uid: "1e000102"
id: kimi-code.libs.i18n-runtime
parent: kimi-code.libs
name: {zh: "i18n 运行时", en: "i18n runtime"}
description:
  zh: >
      t() 的两种后端：优先走引擎的 translate（可选原生快速路径），模块缺失时回落纯 JS 扁平表。
      
  en: >
      The two backends behind t(): the engine's translate when the native module loads, falling back to the pure-JS flat map when it does not.
      
revision: 779fa7ba58daaeed4dd885c941bf1c29d2fe902e
updated_at: "2026-09-29T11:43:39.003Z"
fingerprint: 5d71281ba78fc35769e7fe948f61ba070146f368cc699702506b4a47a7d9d3b2
source:
  - path: "packages/i18n-runtime/src/i18n.ts"
apis: []
deps:
  - kind: call
    to: kimi-code.engine.napi
    label: {zh: "可选原生路径（软依赖）", en: "native fast path (soft)"}
---
