# Progress — hello-world staged dev-run mode

## 状态

- [x] 调研（SDLC 9 环节 + B 站模型乱斗评分做法，来源见 requirements.md）
- [x] 计划定稿：requirements.md / design.md / tasks.md
- [x] 现状调查（swarm A，3 路只读；报告 .tmp/…/reports/a1-a3）
- [x] 实施 B1 引擎+SDK → B2 状态链 / B3 TUI / B4 文档（并行 swarm）
- [x] 独立核验 C1–C3 三维度打分；B3 目标正确 7 分打回 → 重做（R1）→ C3 复评 9 分，打回清单清空
- [x] 终检门禁 + commit/push + 最终报告（见下）

## 核验得分矩阵（0–10，证据全文在 .tmp/hello-world-dev-workflow/reports/，提交前已删除）

| 区域 | 无回归(C1) | 无错误(C2) | 目标正确(C3) | 结论 |
| --- | --- | --- | --- | --- |
| B1 引擎+SDK | 9 | 10 | 9 | 采纳 |
| B2 状态链 | 9 | 9 | 9 | 采纳 |
| B3 TUI | 9 | 10 | 7→9（R1 复评） | 打回后采纳 |
| B4 文档 | 10 | 10 | 8→9（R1 复评） | 采纳 |
| 集成补丁 registry+i18n | 9 | 10 | 9 | 采纳 |

红线（破坏既有测试/门禁新增报错/删错文件/注释禁区/比较字符串本地化/硬编码密钥/身份泄露）：全部未触发。
A1–A8 验收逐条闭合（C3 复评后 A2 断链修复，`/hello-world <task>` 双入口透传 task 至
`session.setHelloWorldMode(enabled, trigger, task)`，测试以精确三参断言钉住）。

## 决策与契约偏差（均按代码事实决断并留档）

1. run 产物落 `specs/<id>/` 四件套；软门禁（证据推进+checklist+off 警告），无编码工具 veto；
   7 阶段；移除轮末自动退出与 Agent veto（详见 design.md 取舍表）。
2. design.md「enter 事件即可驱逐冲突模式」不成立（dispatcher 仅向 observable 事件分发）→
   `setHelloWorldMode` 改为显式 `mutex.leave` 冲突模式后 `enter(trigger, task)`（同 setTowerMode
   写法）；modeMutex 本体未动，互斥测试全绿。
3. `HelloWorldModeEnter`/状态事件附带 `helloWorldStage` 以保 A6 链路完整；`setHelloWorldMode`
   增 `task` 参数（A2 记录 task 必需）。
4. 旧 journal 回放 `modes['hello-world']` 形状由 `{}` 变 `{ stage: 'requirements' }`（回放快照微变，
   兼容面可接受，C1 扣 1 分留档）。
5. 旧 `allows AgentSwarm while hello-world mode is active` 用例随 veto 机制删除（行为平凡成立），
   由新 `does not veto the Agent` 用例覆盖 A5，属覆盖收缩非回归。
6. 文档侧额外接线 `docs/.vitepress/config.ts` 侧栏两行（docs/DEVELOP.md 要求新页接线）。

## 非阻塞事项（核验建议，留待后续）

1. `gen-wire-manifest` 对 `readonly <union>[]` 展开缺括号（wire-manifest.d.ts:405 渲染瑕疵，不影响
   编译/门禁）。
2. `tools/review/orphan-exports-baseline.txt` 建议补录既有 orphan `assertSubagentDepthAllowed`
   （review 全量跑的 1 error，文件不在本轮 diff，见 C2 证据）。
3. `tools/review/silent-catch-baseline.txt` 两条失效基线指向已删除的 team 文件（上一轮 Team 删除
   的遗留，建议顺手清理）。

## 既有失败与外部阻塞（与本次改动无关，逐条证明）

1. `apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts` 9 个 session-rating survey 用例——
   文件内用例污染：单跑/按 describe 跑全绿，HEAD 整跑已红（本轮开始前已复测；C1/C3 亦独立复核）。
2. 整套并发跑时 `apps/kimi-code/test/cli/v2-run-print.test.ts` 偶发 contention（单跑 24 全绿）。
3. `packages/klient` tsdown 构建失败：`?raw` 加载 os error 123（HEAD 已红）。
4. `apps/kimi-inspect`、`apps/vis/*` typecheck `Cannot find name 'Bun'`（HEAD 已红；C2 判定证据：
   报错文件 spawnTool.ts/oauth store.ts 均不在本轮 diff）。
5. review 全量 1 条 orphan-exports error（`assertSubagentDepthAllowed`，既有提交 99c240518e 引入，
   本轮 diff 零引用；§6 门禁 text-as-protocol 本身 0 error）。
6. 外部阻塞：`git push github.com:443` 网络不通（上一轮 push 已失败两次；本轮提交后重试，失败则
   本地领先 origin 并在此记录）。

## 门禁终检记录（最终树）

- `bun run lint`：0 error（14381 warnings，均既有，不计）
- `bun run check:no-comments`：OK（2078 files）
- `bun run check:t-coverage`（exit=0）/ `check:locale-keys` / `check:locale-placeholders` /
  `check:prompt-ownership`：全绿
- `tools/review --check=text-as-protocol`：1 check · 0 error
- packages/{agent-core-v2,transcript,kap-server,node-sdk}、apps/kimi-code typecheck：全 0
- `bun run gen:manifests`：幂等，diff 仅 `hello_world_run.updated` / `helloWorldRun` 预期条目
- `bun run test`（全仓）：kimi-code 4821 pass/9 fail（恰为 §5.1 基线）、vscode 405 pass、vis-web
  61→**修复后 62 pass**（新增红已消）、其余包全绿
- `test/app/agentProfileCatalog` + `test/features/deepseekAdaptation`：142 pass（兼容用户在
  deepseek.md 的 Token budget 备注）

## 全仓 run 发现并修复的新增红（记录）

- `apps/vis/web/test/renderers.test.ts`（wire renderers 覆盖）：新持久事件 `hello_world_run.updated`
  需要渲染器——已补 `renderers.tsx` 条目与 en/zh `wireRenderer.helloWorldRunStage` 键，62 pass。
  该包不在 tasks.md §6 门禁清单（C2 未覆盖），由终检 `bun run test` 全仓跑捕获——收口以全仓 run 为准。

## 用户自有改动说明

- `packages/agent-core-v2/src/app/agentProfileCatalog/model-adaptations/curated/deepseek.md` 的
  「## Token budget」段为**用户本人添加**（曾被我误判为夹带而还原，经用户指正已按原样恢复，
  blob 哈希与原改动一致），单独一个 chore 提交随分支推送。

## 每步进展

- 计划三件套写入本 spec 目录并退出 spec 模式；swarm A 现状调查（a1–a3 报告）→ design 修正 3 处。
- swarm B：B1 引擎+SDK（109 定向+304 node-sdk 全绿）与 B4 文档并行；B2 状态链（162+1396 绿）与
  B3 TUI（447 定向绿）并行。
- swarm C 独立核验（C1/C2/C3）：C3 判 B3 目标正确 7 分打回 → agent-10 重做（R1）→ agent-13 复评 9 分。
- 集成补丁：registry 补全/hint + i18n 4 键 ×2 语（子代理清单遗漏项）。
- 终检门禁全绿后清理 .tmp scratch、commit 并尝试 push。
