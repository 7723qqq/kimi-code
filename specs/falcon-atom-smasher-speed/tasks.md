# Tasks — 函数签名与全量 API 面对照

前置：`requirements.md`（口径与范围）、`design.md`（方案）。本文件只列可执行步骤与完成判据。

## 阶段 A — 枚举

### A1 签名枚举器

- [ ] `src/enumerate-signatures.mjs`：38 个 `node:` 模块，记录每个导出函数的 `length` 与 `name`。
- [ ] 递归一层 `util.types`、`stream/promises`、`dns/promises`。
- [ ] 跳过 `_` 前缀与 `prototype`，与前三类保持一致。
- **判据**：在 Node 与 Bun 上各跑一次，两份输出均可被 `JSON.parse` 解析。

### A2 两侧取数

- [ ] `node src/enumerate-signatures.mjs node > n.json`
- [ ] `bun src/enumerate-signatures.mjs bun > b.json`
- **判据**：两份报告的模块数相同，且大于 30。

## 阶段 B — 比对

### B1 签名比对器

- [ ] `src/compare-signatures.mjs`：输出 `lengthDiffers` / `nameDiffers` / `missing` / `extra` 四类。
- **判据**：能对给定两份报告输出分组结果，退出码 0。

### B2 初次取数

- [ ] 跑一遍，记录四类差异的数量与具体条目。
- **判据**：能说出 `length` 差异的准确条数与模块分布。

## 阶段 C — 筛选与入表

### C1 判定哪些会伤人

- [ ] 按 `design.md` 的三条判据筛选：影响 arity 分支、影响堆栈/反射、被 promisify 消费。
- [ ] 按同一根因合并同类项。
- **判据**：每条入选条目能说出“什么代码会因此走错”。

### C2 `src/signature-gaps.mjs`

- [ ] 每条含 `module`、`member`、`node`、`bun`、`impact`、`workaround`、`severity`。
- [ ] 值一律来自实测，不填文档值。
- **判据**：表内每条的两侧值能被测试复算出来。

## 阶段 D — 守卫

### D1 `test/signature-gaps.test.mjs`

- [ ] 实时枚举两侧，未登记的长度差异必须失败。
- [ ] 表中某项已一致时打印 retire 提示，不失败。
- [ ] 每条表项都有非空 `impact` 与 `workaround`。
- **判据**：故意删掉一条表项时测试变红；故意改错一个值时测试变红。

### D2 接入报告

- [ ] `rules-report.mjs` 增加签名段，与缺失/静默/数值并列。
- **判据**：一条命令能看到四类差异。

## 阶段 E — 收口

### E1 门槛

- [ ] `bun test --isolate tools/bun-migrate/test/` 全绿
- [ ] `bunx oxlint tools/bun-migrate` 0 警告 0 错误
- [ ] `bun run check:no-comments` OK
- **判据**：三条全部退出码 0。

### E2 文档

- [ ] `tools/bun-migrate/README.md` 增加签名差异一节，说明为什么它排在四类之末但同样会伤人。
- [ ] 更新覆盖数字（规则数、套件数、断言数）。
- **判据**：README 的数字与实测一致。

## 后续（本 spec 之外）

- ~~82 个 Bun 独有顶层导出的逐条归档~~ **已完成**：`src/bun-surface.mjs` 用三张表覆盖全部 112 个顶层导出（35 有 Node 等价物 / 55 Bun 独有函数 / 22 对象命名空间），`test/bun-surface.test.mjs` 保证无遗漏。
- ~~`node:inspector` / `node:repl` / `node:wasi` 的覆盖~~ **已完成**：三个模块全部纳入枚举，实测 `node:inspector` 缺 `Network` 与 `NetworkResources`（已入缺口表），`node:repl` 在 Bun 多一个 `repl` 导出，`node:wasi` 与 `node:trace_events` 两侧完全一致。
- 三参数以上深层嵌套对照（仍未做）

## 风险

| 风险 | 应对 |
| --- | --- |
| `fn.name` 噪音大 | 只在影响堆栈/反射时入表 |
| 枚举慢 | 只读函数属性，单轮 1 秒量级 |
| 表过期 | 每次运行重算并提示 retire |
