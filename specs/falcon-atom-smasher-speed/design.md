# Design — 函数签名与全量 API 面对照

## 总览

```
enumerate-signatures.mjs  (node)  ─┐
                                   ├─► compare-signatures.mjs ─► 差异报告
enumerate-signatures.mjs  (bun)   ─┘                │
                                                    ▼
                                       signature-gaps.mjs  (人工筛选，只留会伤人的)
                                                    │
                                                    ▼
                                       test/signature-gaps.test.mjs  (实时重算守卫)
```

三个组件，与前三类差异保持同构：一个枚举器、一个比对器、一张人工筛选过的表，加一个守卫测试。

## 组件一：`enumerate-signatures.mjs`

对 38 个 `node:` 模块，读取每个导出函数的两项：

```ts
{ length: number, name: string }
```

`length` 是形参个数（首个默认参数或 rest 之前的数量），`name` 是推断名。

嵌套容器 `util.types`、`stream/promises`、`dns/promises` 递归一层。深度上限两层，与“数值”层一致。

输出 JSON：`{ engine, version, modules: { [module]: { functions, nested } } }`。

设计约束：

- 用 `getOwnPropertyNames` 而非 `Object.keys`，因为不可枚举的导出同样可调用。
- 读取属性时 try/catch，getter 抛错不应中断整轮枚举。
- 单行 JSON 输出，方便 `head -1` 过滤掉运行时的 stderr 警告（前几轮已踩过这个坑）。

## 组件二：`compare-signatures.mjs`

四类差异：

| 类型 | 含义 | 判定 |
| --- | --- | --- |
| `lengthDiffers` | 形参个数不同 | `node.length !== bun.length` |
| `nameDiffers` | 函数名不同 | `node.name !== bun.name` |
| `missing` | Node 有、Bun 无 | 键不存在 |
| `extra` | Bun 有、Node 无 | 键不存在于 node 侧 |

输出按类型分组，每组带模块名与实测值。

## 组件三：`signature-gaps.mjs`

人工筛选层。只留满足以下任一条件的条目：

1. **arity 影响分支**：调用方可能写 `fn.length === N` 或依赖返回函数的参数个数。
2. **名称出现在堆栈或反射结果里**：错误信息、`Function.name` 判断。
3. **被 `util.promisify` 一类工具消费**：promisify 会读 `fn.length` 决定返回函数签名。

每条结构：

```ts
{
  module, member,
  node: { length, name },
  bun:  { length, name },
  impact: string,      // 什么代码会因此走错
  workaround: string,  // 能怎么办
  severity: 'silent',
}
```

不同项按“同一根因”合并（例如整组 `promisify` 相关），避免表格膨胀。

## 组件四：守卫测试 `signature-gaps.test.mjs`

三条不变量：

1. **未登记差异必失败**：实时枚举两侧，凡 `length` 不同且不在表中 → 失败。
2. **已消失差异打提示**：表中某项在当前 Bun 上已一致 → 打印 retire 提示，不失败。
3. **表中每条都带证据**：`impact` 与 `workaround` 非空，`node`/`bun` 两侧值存在。

第二条故意不失败：Bun 修好一项是好事，不该让构建变红，但要让人知道表过期了。

## 与前三类的关系

四类差异形成递进，判定成本依次上升：

| 类别 | 检测手段 | 判定成本 | 后果 |
| --- | --- | --- | --- |
| 缺失 | 键存在性 | 低 | 调用即崩，可见 |
| 数值 | 值相等 | 低 | 分支走错，不可见 |
| 静默失效 | 行为探针 | 高（要设计探针） | 功能不生效，不可见 |
| 签名 | `length`/`name` | 低 | 按 arity 分支的调用方走错，不可见 |

签名排在最后不是因为最危险，而是因为它是“存在性”的自然延伸：既然已经在读导出，多读两个属性几乎零成本。

## 执行顺序

1. 写枚举器 → 在两侧各跑一次 → 确认输出可解析
2. 写比对器 → 得到原始差异数量
3. 按 F6/F7 的判据筛选 → 得到会伤人的条目
4. 写测试 → 实时重算，未登记失败
5. 接入 `rules-report.mjs` → 一条命令看到四类差异
6. 跑全套门槛

## 风险

| 风险 | 应对 |
| --- | --- |
| `fn.name` 在压缩或代理后本就不稳定，产生大量噪音 | 只登记影响堆栈或反射的项，其余在比对器输出里可见但不入表 |
| 实时枚举拖慢测试 | 只枚举 38 个模块的函数属性，实测单轮在 1 秒量级 |
| Bun 版本变化导致表迅速过期 | 每次运行都重算并打印 retire 提示，表只作为“已知且已解释”的清单 |
| 误把内部函数差异当公开差异 | 枚举器跳过 `_` 前缀与 `prototype`，与前三类一致 |
