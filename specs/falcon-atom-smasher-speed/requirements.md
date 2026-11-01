# Requirements — 函数签名与全量 API 面对照

本 spec 记录 `tools/bun-migrate` 在“存在性”“静默失效”“数值”三类差异之后，需要补齐的第四类差异：**函数签名**，以及剩余的 API 面对照范围。

## 目标

让 `bun-migrate` 能在把 Node 项目迁到 Bun 之前，回答四个完整的问题：

1. 这个 API 在 Bun 上**存在吗**（缺失 → 调用即崩）
2. 它**真的会工作吗**（静默失效 → 不报错但不做事）
3. 同一个名字的常量**值一样吗**（数值不同 → 分支走错）
4. 同一个函数的**形参个数和名字一样吗**（签名不同 → 按 arity 分支的调用方走错路）

前三项已落地。本 spec 负责第四项，并把对照范围从 53 个模块扩到更完整的覆盖面。

## 受众

维护本 fork、以及用这个工具迁移其他 Node 项目的开发者。读这份文档是为了知道第四类差异为什么重要、判定依据是什么、以及哪些范围仍未覆盖。

## 背景事实（2026-10-30 实测）

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | 前四轮已覆盖三类差异，均有测试与实测支撑 | `tools/bun-migrate/test/` 19 个套件 342 通过 |
| F2 | `node:` 层是 Bun 自研实现，不是转发 Node | `node:fs` → `internal/fs/binding`，`node:path` → `$cpp("Path.cpp")` |
| F3 | 存在性差异 19 条（17 函数 + 2 组 http2 常量） | `src/node-gaps.mjs` |
| F4 | 静默失效 8 条，全部实测不抛错 | `src/silent-gaps.mjs` |
| F5 | 数值差异 17 处，整理为 4 条可伤人项 | `src/constant-values.mjs` |
| F6 | `fn.length` 是首个默认参数或 rest 之前的形参个数，会随实现改变 | ECMAScript 规范定义 |
| F7 | 依赖 arity 的真实场景：`promisify`、柯里化、代理包装、参数校验 | Node 核心自身大量使用 |

**F6/F7 是这份 spec 存在的理由**：一个函数存在、会工作、行为正确，但形参个数变了，`fn.length === 2` 之类的判断就会走错分支，且同样不抛错。

## 范围

### 纳入

1. **函数签名对照**：对 38 个 `node:` 模块的每个导出函数，记录 `fn.length` 与 `fn.name`，两侧 diff。
2. **嵌套函数**：`util.types`、`stream/promises`、`dns/promises` 下的函数同样记录。
3. **差异入表**：`fn.length` 不同的项进 `signature-gaps.mjs`，带影响与替代方案。
4. **名称差异**：`fn.name` 不同也记录，因为堆栈与反射会看到它。
5. **回归测试**：实时重算两侧签名，未登记差异失败，已消失差异打印 retire 提示。

### 明确排除（每条写明理由）

- **属性描述符**（`writable` / `enumerable` / `configurable`）：迁移代码极少依赖，且判定成本高于收益。
- **函数源码文本**（`fn.toString()`）：实现不同必然不同，没有判定价值。
- **三参数以上的深层嵌套对象**：已在“数值”层覆盖到两层，再深不是迁移场景。
- **`node:inspector` / `node:repl` / `node:wasi` / `node:test`**：迁移项目极少直接调用，且 `node:test` 已被 `bun:test` 层覆盖。

## 需求

### R1 — 签名差异必须来自实测

`fn.length` 与 `fn.name` 一律在真实运行时上读取，不允许凭文档或记忆填写。每条差异记录两侧的实测值。

### R2 — 只登记会伤人的差异

`fn.name` 不同只在影响堆栈可读性或反射时登记；纯内部命名差异（如匿名函数推断名不同）不登记，避免表格被噪音填满。

### R3 — 每条差异带影响与替代

与前三类一致：`impact` 说明什么代码会因此出错，`workaround` 说明能怎么办。

### R4 — 实时探针，不存快照

测试每次运行都重新枚举两侧。Bun 补上某项时打印 retire 提示而不是静默通过；新增差异时测试失败。

### R5 — 覆盖范围可复算

枚举器必须能独立运行（`bun src/enumerate-signatures.mjs bun > out.json`），结果可复现，模块清单写在代码里可审阅。

## 验收

1. `src/enumerate-signatures.mjs` 在 Node 与 Bun 上各产出一份可解析报告。
2. `src/compare-signatures.mjs` 输出按差异类型分组的结果。
3. `src/signature-gaps.mjs` 收录全部会伤人的签名差异，每条有 `impact` 与 `workaround`。
4. `test/signature-gaps.test.mjs` 实时校验，且能对每条差异给出两侧实测值。
5. 全套测试绿，`oxlint` 与 `check:no-comments` 通过。
