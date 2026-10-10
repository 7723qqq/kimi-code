# Requirements — 逐项落地梳理报告中的「待改进事项」

## 目标

按 A → B → C 的顺序，把上一轮代码梳理报告中列出的 17 项待改进事项逐项落地。每项要么产生一处最小化改动，要么产出一份说明「为何不改」的证据（例如实为有意设计）。

**本轮不是重构**：默认动作是删除死代码、修正过期文档、去重、把已有门禁收敛到可本地复现的位置。任何超过「局部删除 / 单点改名 / 单行文档修正」的动作，都必须先在本 spec 中给出方案并经确认。

## 交付物

1. 每一组（A/B/C）完成后的**逐项汇报**：改动的文件路径 + 执行的验证命令 + 结果。
2. 对报告中判断有误的条目，给出**不改的理由**与证据（`path:line`）。
3. 用户可见的行为变更补 `.changeset/*.md`；纯文档/删除死代码不需要。

## 受众

仓库维护者（本 fork 的 owner）。每条汇报必须能独立读懂，不需要重新推导证据。

## 范围

- **A 组（一致性）**：A1 DEVELOP.md kosong 描述、A2 kosong 定位、A3 notify 常量边界泄漏、A4 tsconfig 过期排除项、A5 i18n 收敛。
- **B 组（重复代码）**：B6 重复压缩提示词、B7 压缩实现关系、B8 `scan-hardcoded.mjs`、B9 `cli/v2` 命名 + dev 脚本、B10 `dev:server` 重复。
- **C 组（可维护性）**：C11 ~ C17，**先评估给方案，确认后执行**。

## 边界与约束

- 仓库自身的门禁与约定以 `DEVELOP.md`、各目录 `AGENTS.md` 为准，本 spec 不复制它们。执行时按改动范围选择对应命令：`oxlint --type-aware`、`oxfmt`、`vitest`；涉及 `agent-core-v2` 时加 `check:boundaries`、`check:deep-imports`；涉及 i18n 时加 `check:locale-keys`、`check:t-coverage`。
- 改动按文件路径精确定位，不顺手重构无关代码。
- `tools/review` 的基线台账（`tools/review/*-baseline.txt`）是「已接受的技术债」清单；本轮若使某条台账失效，必须同步删除该条（`review` 会报告失效条目）。

## 事前基线（动工前已存在的状态，判定验收时必须扣除）

两项在调查阶段复现，且都不是本轮引入的；完整证据见 `design.md` §A0。

1. **`check-no-comments.mjs` 当前为红灯**：exit 1，154 处违规，全部在 `packages/agent-core-v2`（src 78 / test 76）。违规文件在 HEAD 上未修改，属已提交状态，由最近的 DeepSeek adaptation 一轮工作引入。本轮**不改**它（不在原报告范围内）；因此所有任务的验收**不得**要求该脚本退出码 0，只能要求「违规数不高于 154」。
2. **工作树已有未提交改动**：`apps/kimi-code/src/i18n/locales/{en,zh}.json`（2 文件 6 增 2 删）。这使 CI 的 locale JSON freshness 步骤（`ci.yml:188`）在动工前即为红。本轮不处置这两处改动；T5 的验收不得依赖「工作树干净」。

其它已实测的绿灯基线（验收时用作出入参照）：`check-import-boundaries` OK（1710 files）、`check-deep-imports` OK、`bunx oxlint --quiet` 0 error / 6893 warning、`tools/review` 0 error / 10 warning、`bunx oxfmt --check` 通过。


## 明确不在范围内

- **A0.1 的 154 处 `check-no-comments` 违规**：不在原报告清单内，属既有红灯；本轮只记录，不修复（可选追加任务由用户决定）。
- **A0.2 的未提交 locale JSON 改动**：属用户在手工作，本轮不动。
- 不做引擎层的架构重构（DI 分层、wire 协议、`human`/`agent` 目录搬迁）。
- 不统一 `node-sdk` / `klient` / `kap-server` 的客户端分层。
- 不重命名 `packages/node-sdk/src/v2/`（与 `apps/kimi-code/src/cli/v2/` 是两件事）。
- 不升级依赖、不改动 `flake.nix` / Bun 工具链。
- 不发布、不执行 `changeset version`（C17 只做只读盘点与建议）。
- 不修改 `apps/kimi-code/dist-web/**`（524 个已提交的预构建产物，`DEVELOP.md` 明确其同步约定）。
- 不重命名 `apps/kimi-code/src/cli/v2/`（`apps/kimi-code/DEVELOP.md:45` 固化的策略名词）。

