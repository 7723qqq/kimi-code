# Requirements — hello-world 模式承载完整开发流程（staged dev-run mode）

## Goal

把 `hello-world` 模式从「与 swarm 行为相同的占位」升级为**带阶段门禁的开发 run 全流程模式**：
进入模式即开启一次 dev run；run 沿 7 个阶段推进（requirements → design → implement → test →
review → docs → deliver），每阶段有模型剧本（注入文案）、证据驱动的推进规则、checklist 与收尾摘要；
TUI 显示当前阶段并提供 `status / next / phase / skip` 子命令。维护（maintain）不是 run 内阶段，
而是收尾闭环：遗留项按四类维护归档，回流为下一轮 run 的需求种子。

全程 AI 闭环交付：调研、计划、实施、核验、提交均由 agent 完成；不确定取舍按仓库规则与代码事实
自行决断并在最终报告说明。

## 调研结论（业界完整 SDLC，来源清单见文末）

从业者共识的完整流程为 9 个环节：需求、设计、实现、测试、代码评审、文档、版本管理、CI/CD、发布维护。
本需求将其折叠为 7 个 run 阶段，映射关系：

| run 阶段 | 覆盖的调研环节 | 核心产物 |
| --- | --- | --- |
| requirements | 需求（SRS、验收标准 Given-When-Then） | `specs/<id>/requirements.md` |
| design | 设计（SDD、任务拆解） | `specs/<id>/design.md`、`tasks.md` |
| implement | 实现 + 版本管理（小步提交纪律，横切） | 代码、聚焦 commit |
| test | 测试（金字塔、shift-left）+ CI 本地门禁 | 测试执行证据 |
| review | 代码评审（Google 清单） | 评审发现与处置 |
| docs | 文档（8 类文档按需） | `docs/`、README 更新 |
| deliver | CI/CD 门禁 + 发布 + changeset | changeset、commit、push |
| （maintain 闭环） | 维护（corrective/adaptive/perfective/preventive） | 收尾摘要、下轮 run 种子 |

## 验收标准（核验「目标正确」维度逐条对照，全部需证据）

- A1 `/hello-world on|off` 开关模式；modeMutex 行为零回归（既有 modeMutex/helloWorld 模式测试全绿）。
- A2 `/hello-world <task>` 开启 run 并记录 task；run 跨轮次存活——移除轮末自动退出语义。
- A3 阶段机可用：7 阶段、证据表自动推进（见 design.md）、`next` 与 `phase <stage>` 手动推进、
  `skip <item>` 豁免 checklist 项并留痕。
- A4 注入按阶段渲染剧本，不再复制 swarm 文案；退出时注入收尾摘要指引（open items、
  `specs/<id>/progress.md`、四类维护归档、下轮 run 种子）。
- A5 模式内工具不受限：移除 Agent 工具 veto（开发流程需要 Agent/AgentSwarm 等全部工具）。
- A6 阶段可见：footer 徽章 `hello-world:<stage>`、`/status` 行、`/hello-world status` 面板、
  status 事件链（usageEvents → node-sdk → kap-server → transcript `modes['hello-world'].stage`
  与 `hello-world.stage` marker）、会话恢复后可读。
- A7 门禁全绿：`bun run lint`、`bun run check:no-comments`、相关包 `typecheck`、`bun run test`、
  `check:t-coverage`、`check:locale-keys`、`check:locale-placeholders`、`check:prompt-ownership`、
  text-as-protocol（tools/review）；`bun run gen:manifests` 后无意外差异。
- A8 文档与行为一致（docs/{zh,en}/reference/slash-commands.md、新增 docs/{zh,en}/guides/hello-world.md、
  DEVELOP.md/README fork 列表、changeset 文案），无死键/死代码/占位残留。

## 非目标

- 不改 swarm / AgentSwarm / plan / spec / tower / goal 的既有行为；不 bump 版本；不发明新流水线
  （deliver 阶段门禁即本仓 CI job 的本地等价清单）。
- 不做强硬编码工具 veto（过度门禁为已识别风险，见 design.md 取舍表）。

## 调研来源

SDLC 框架：IBM《What is the SDLC》（7 阶段，https://www.ibm.com/think/topics/sdlc ，中文版
https://www.ibm.com/cn-zh/think/topics/sdlc ）；Atlassian《What Is Software Development》
（https://www.atlassian.com/software-development ）；沙特 DGA《SDLC Methodology Guideline》
（https://dga.gov.sa/sites/default/files/2024-06/Guideline%20for%20Software%20Development%20Life%20Cycle%20%28SDLC%29%20Methodology-V1.0_0.pdf ）。
需求与验收：IEEE/ISO/IEC 29148-2018（https://standards.ieee.org/ieee/7000/6937/ ）；用户故事/验收标准
（INVEST、Given-When-Then，https://www.scitepress.org/Papers/2022/110820/110820.pdf ）。
评审：Google eng-practices《What to look for in a code review》
（https://google.github.io/eng-practices/review/reviewer/looking-for.html ）。
测试：英国内政部《Test pyramid》（https://engineering.homeoffice.gov.uk/standards/test-pyramid/ ）；
Microsoft《Shift left testing》（https://learn.microsoft.com/en-us/devops/develop/shift-left-make-testing-fast-reliable ）。
文档：Atlassian《9 Software Documentation Best Practices》
（https://www.atlassian.com/blog/loom/software-documentation-best-practices ）。
版本管理：Martin Fowler《Patterns for Managing Source Code Branches》（https://martinfowler.com/articles/branching-patterns.html ）；
HMCTS《Branching strategy》（https://hmcts.github.io/standards/practices/branching.html ）。
CI/CD：Software Engineering Guide 8.1（https://software-engineering-guide.github.io/software-engineering-guide/chapters/08-01-ci-cd-and-delivery/ ）；
Microsoft code-with-engineering-playbook《Continuous Delivery》
（https://github.com/microsoft/code-with-engineering-playbook/blob/main/docs/CI-CD/continuous-delivery.md ）。
维护：ISO/IEC/IEEE 14764:2022（https://www.iso.org/standard/80710.html ）；IEEE 维护类型综述
（https://technav.ieee.org/topic/software-maintenance/ ）；Software Engineering Guide 3.7
（https://software-engineering-guide.github.io/software-engineering-guide/chapters/03-07-software-maintenance/ ）。
核验评分参考（B 站模型乱斗实践）：UP 主「Token就是词元」（uid 3546747185924773）「屎山论剑 / 屎山考核」
系列（BV1j9Hu6CEMx、BV1V1nb6oE6y、BV1zcJf6LEPe）：同题同环境多模型对照、分组分轮、成败明确判负、
过程全程可复看、按维度点评。
