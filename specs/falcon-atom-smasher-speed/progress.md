
## 追加 — spec 的「后续」项已完成

### Bun 独有顶层导出：112 个全部归档

`src/bun-surface.mjs` 三张表：

| 表 | 数量 | 含义 |
| --- | --- | --- |
| `HAS_NODE_EQUIVALENT` | 30 | 有 Node 路径可用（21 条无条件，9 条带 caveat） |
| `BUN_ONLY_FUNCTIONS` | 60 | Node 无对应能力 |
| `BUN_ONLY_NAMESPACES` | 22 | 无 Node 形状的对象命名空间 |

`dependencySafety(name)` 回答「这个 API 会不会让包变成 Bun-only」：字节相同返回 `safe: true`，有已知差异（含 gzip 这类可互通但字节不同）返回 `conditional: true`，Bun 独有返回 `safe: false`，未知名称返回 `unknown: true` 而非假装安全。

测试 `bun-surface.test.mjs` 的第一条断言就是「无遗漏分类」，首次运行抓出 10 个未分类项（MD4、SHA224、SHA384、SHA512_256、CSRF、enableANSIColors、fetch、unsafe、zstdCompress、zstdDecompress），已补齐。

### 三个此前排除的模块：全部纳入

| 模块 | 实测结论 |
| --- | --- |
| `node:inspector` | Bun 缺 `Network` 与 `NetworkResources` → 已入缺口表 |
| `node:repl` | Bun 多一个 `repl` 导出，Node 侧无 |
| `node:wasi` | 两侧完全一致 |
| `node:trace_events` | 两侧完全一致 |
| `node:readline/promises` | 两侧完全一致 |

排除理由已失效：它们不是「极少被调用所以不用查」，而是「已查过，结论如此」。枚举清单从 38 个模块扩到 44 个。

### 缺口表最终状态

22 条，全部 open（无一可退役）：
- `node:http2` 常量 2 组
- `node:module` 5 条
- `node:util` 4 条
- `node:console` 2 条
- `node:crypto` 2 条
- `node:dns` / `dns/promises` 2 条
- `node:inspector` 2 条
- `node:domain` / `node:v8` / `node:diagnostics_channel` 各 1 条

### 最终门槛

534 通过 / 0 失败（24 个套件，1902 断言）；`oxlint` 0 警告 0 错误；`check:no-comments` OK（2139 文件）。`src` 24 个文件（含 `layers/` 共 30 个），`test` 24 个套件。
- **E2** README 已补签名一节与覆盖数字。
- **E3** 错误形态维度从 17 条同步用例扩到 30 条（含 10 条异步），查出 5 条真实分歧并全部登记。
- **E4** 四层静默失败已修：`--only` 参数校验、`vitest.config.ts` 迁移到 `bunfig.toml`、node-gap 检测改 AST 绑定、CI workflow 层从死代码变为可运行（含 CRLF 与 `with:` 归属）。

## 结论

第四类差异已覆盖。与前几轮不同的是，这一轮的主要产出是**一个否定的结论**：123 处形参差异里只有 8 处会影响调用方，其余是 Bun 的实现选择（rest 参数包装器）而非兼容性问题。把这个结论写进表，比把 123 条全部列出来更有用。

## 仍未覆盖（诚实的剩余清单）

- 属性描述符（`writable` / `enumerable` / `configurable`）——判定成本高于迁移价值
- 函数源码文本（`fn.toString()`）——实现不同必然不同，无判定价值
- 三参数以上深层嵌套——已覆盖到两层，更深不是迁移场景
- 网络 I/O 与冷页缓存下的性能数据——目前性能结论全部来自 Windows x64 热缓存

已从「未覆盖」中移出（本轮完成）：
- 112 个 Bun 独有顶层导出已全部归档
- `node:inspector` / `node:repl` / `node:wasi` / `node:trace_events` / `node:readline/promises` 已纳入枚举
