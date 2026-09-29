---
uid: "1e000101"
id: kimi-code.libs.i18n-catalog
parent: kimi-code.libs
name: {zh: "i18n 词条目录", en: "i18n catalog"}
description:
  zh: >
      双语词条的唯一来源：en.ts / zh.ts 树，由 generate-locale-json.cjs 编译成引擎内嵌的 locales/*.json。
      
  en: >
      The single source of every bilingual string: the en.ts / zh.ts trees, compiled by generate-locale-json.cjs into the engine's embedded locales/*.json.
      
revision: 779fa7ba58daaeed4dd885c941bf1c29d2fe902e
updated_at: "2026-09-29T11:43:39.003Z"
fingerprint: 78252d1586237153cf097a025497f17d348d1fa77e29d2d7cb43c0d1fcdd9a4d
source:
  - path: "packages/i18n-catalog/src/index.ts"
apis: []
deps:
  - kind: dataflow
    to: kimi-code.libs.i18n-runtime
    label: {zh: "运行时按 key 取词条", en: "runtime reads strings by key"}
---
