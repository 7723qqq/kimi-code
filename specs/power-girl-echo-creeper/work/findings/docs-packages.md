# 发现：packages/{klient,telemetry,oauth,node-sdk,kosong,kaos} 下的 .md

范围：`packages/klient/{README,DEVELOP,CHANGELOG}.md`、`packages/telemetry/{README,CHANGELOG}.md`、
`packages/oauth/{README,CHANGELOG}.md`、`packages/node-sdk/{README,CHANGELOG}.md`、
`packages/kosong/{README,CHANGELOG}.md`、`packages/kaos/{README,CHANGELOG}.md`（共 13 个文件，全部通读并与实现比对）。

## 发现

- `packages/klient/README.md:94` — 类别 3 · 高 — 说明：README 把「file upload」列入「What it deliberately leaves out (for now)」（该短语跨 94–95 行，`file` 在 94 行末、`upload (v1 multipart REST only)` 在 95 行首），代码实际已把文件上传放在 facade 上：`GlobalFacade.files`（依据：`packages/klient/src/core/facade/global.ts:322`）及其实现 `files: { save/get/delete }`（依据：`packages/klient/src/core/facade/global.ts:572`）；同包 `packages/klient/DEVELOP.md:32` 也写明「File upload IS on the facade (`global.files`)」，两处文档互相矛盾。

- `packages/kosong/README.md:30` — 类别 3 · 高 — 说明：README「Relationship to agent-core-v2」声称「`agent-core-v2` depends on this package. Its `src/kosong/` layer keeps the DI/trait composition machinery … the engine's `contract/` directory is a thin re-export of this package」（30–34 行），代码实际是：`agent-core-v2` 的 `dependencies` 里没有 `@moonshot-ai/kosong`（依据：`packages/agent-core-v2/package.json:59`–`packages/agent-core-v2/package.json:91`，全仓库仅 `packages/oauth`、`packages/node-sdk`、`apps/vis/server` 依赖 kosong）；`packages/agent-core-v2/src/kosong/` 目录不存在；引擎的 `src/contract.ts` 只再导出自身 `#/...` 模块（依据：`packages/agent-core-v2/src/contract.ts:1`），其 `llm-adapter/contract/` 是自研实现、从 `#human/llm/message` 导入而非再导出 kosong（依据：`packages/agent-core-v2/src/llm-adapter/contract/message.ts:1`）。

- `packages/klient/README.md:44` — 类别 3 · 中 — 说明：README 把 `providers.*`、`models.*`、`catalog.*` 列为 `klient.global.*` 的成员，代码实际是 `GlobalFacade` 只有 `sessions / workspaces / config / kosong / auth / flags / plugins / capabilities / hostFs / files / mcp / env()`（依据：`packages/klient/src/core/facade/global.ts:312`–`packages/klient/src/core/facade/global.ts:325`），provider/model/catalog 能力全部挂在 `kosong` 下（依据：`packages/klient/src/core/facade/global.ts:316` 与 `packages/klient/src/core/facade/global.ts:161`）；`providers`/`models`/`catalog` 恰是引擎服务名（依据：`packages/klient/src/contract/index.ts:57`–`packages/klient/src/contract/index.ts:59`），与 README 同段「no engine service tokens」自相矛盾。

- `packages/klient/README.md:11` — 类别 3 · 中 — 说明：README 快速上手示例写 `const { app } = bootstrap({ homeDir }, [...])`，代码实际要求 `clientIdentity` 为必填字段（依据：`packages/agent-core-v2/src/app/bootstrap/bootstrap.ts:105`），同包真实调用带该参数（依据：`packages/klient/examples/smoke.ts:32`），照抄示例无法通过类型检查。

- `packages/node-sdk/README.md:17` — 类别 1 · 中 — 说明：README 声称「Requires Node.js 22.19.0 or later.」，仓库实际已把发布包的 engines 从 `node >= 22.19.0` 改为 `bun >= 1.4.0`（依据：`.changeset/drop-node-pty-bun-only.md:5`），并声明 Node.js 已不再需要、发布包 engines 为 `bun >= 1.4.0`（依据：`DEVELOP.md:268`–`DEVELOP.md:269`）；node-sdk 自身 package.json 无 `engines` 字段（依据：`packages/node-sdk/package.json:2`）。

- `packages/kaos/CHANGELOG.md:25` — 类别 3 · 低 — 说明：kaos 0.1.3 的 CHANGELOG 声称「Fix glob pattern backslash escaping and include match count in truncation messages」，其中后半句不属于 kaos：kaos 的 `glob` 只返回 `AsyncGenerator<string>`，全包（src + test）没有任何截断消息（依据：`packages/kaos/src/local.ts:300`–`packages/kaos/src/local.ts:304`）；「match count in truncation messages」实际落在 `packages/agent-core-v2/src/agent/tools/os/glob/globTool.ts:285`（同一条 changeset 同时列了 `@moonshot-ai/kaos` 与 `@moonshot-ai/agent-core`）。

## 已核实为真、未报告（避免误报）

- klient：`test/helpers/conformance.ts`、`test/contract-parity.ts`、`src/contract/helpers.ts` 的 `maybe()`/`noResult()`、`ensureMainAgent`、`OrderedHookSlot`、`serveKlientIpc({ scope, socketPath })`、`validate: false`、ipc/memory 共享 dispatcher、`KIMI_SERVER_URL` 默认端口 58627、`KIMI_SERVER_E2E_FALLBACK_BASE_IMAGE` 默认 `node:24-bookworm`、`bun run smoke|smoke:boundary|smoke:select-tools|docker:e2e|typecheck`、`examples/{smoke,basic,context-usage,model-requester-boundary,kimi-select-tools}.ts`、`test/e2e/{legacy,harness}/`、`test/e2e/legacy/log.ts`、全局/会话/agent 事件名、`sessions.list({ limit })`。
- oauth：`X-Msh-Platform = kimi_code_cli`、`userAgentProduct`→`productName` + 必填 `platform`、`fetchChatTitle` 的 8s 超时与结构化失败、`./device` 子路径的导入闭包确实无 Node 内建。
- telemetry：`setTelemetryEnabled`、`initiallyEnabled`。
- kaos：`toForwardSlashes`/`node:path/win32`/`joinPath` 确已移除并改用 `pathe`、Scoop 等 shim 经 `git --exec-path` 解析、`BufferedReadable._destroy` 会关闭源流。
- kosong：`createProvider`、`KimiChatProvider`、`Error2`、`ChatProvider`、`TokenUsage`、`ModelCapability` 及全部列出的 wire helper 文件均存在。
- node-sdk：`getConfig`/`setConfig`、`auth.ts`/`session.ts`/`events.ts`/`sdk-rpc-client-v2.ts`、harness 的 create/cancel/export/rename/resume/steer、`examples/` 下 auth/config/cancel/export/list/rename/set-model/logging 冒烟脚本、`homeDir` 省略时默认 `~/.kimi-code`。
