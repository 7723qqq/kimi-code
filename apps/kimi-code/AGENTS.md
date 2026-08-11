# apps/kimi-code Development Guide

This file only contains rules local to `apps/kimi-code`. For cross-repo rules, see the root `AGENTS.md`.

> **FROZEN — TS 迁移冻结（2026-08-10）**：本应用剩余 TS（CLI 消费面 + i18n/utils/constant）是过渡态宿主，目标迁入 Rust（kimi-cli / kimi-tui）。
> - 允许：关键 bug 修复（崩溃 / 数据丢失 / 安全 / 生产日志污染）；测试基线必要适配。
> - 禁止：新增功能、引擎逻辑、行为修补、UI 微调。新能力一律写 Rust。
> - 历史：TS TUI 已退役（2026-08-09，`cba21d159`，删除 `src/tui/` + `test/tui/` 共 312 文件），交互 UI 由 Rust `kimi-tui` 提供。`write-tui` 技能只适用于已退役的 TS TUI，**不要**再按它修改本目录。
> - 历史：TS 入口已退役（2026-08-11，G-7 收尾）：`src/` 全部移入 `retired/kimi-code-src/`，本应用成为纯分发壳。冻结对象（TS 宿主）已不存在，FROZEN 约束不再适用；壳内不得重新引入引擎或 UI 逻辑。

## 当前结构（G-7 后：纯分发壳）

本应用不再包含 TS 源码。`bin/kimi.mjs` 是唯一入口：探测并 spawn 平台 Rust 二进制（kimi-cli），找不到时提示 `cargo build --release -p kimi-cli`（错误信息见 bin/kimi.mjs）。

- `bin/kimi.mjs`：纯 Rust spawn 壳（无 TS 回退）。`KIMI_RUST_BIN` 可覆盖二进制路径。
- `dist-web/`：web 前端资产（最终唯一 TS 的产物），由 `pnpm build`（`pnpm -C ../kimi-web run build` + `scripts/copy-web-assets.mjs`）生成，随 npm 包分发，供 Rust `web` 子命令 `--assets` 使用。
- `scripts/postinstall.mjs` + `scripts/postinstall/`：npm 全局安装时清理旧 Python `kimi-cli` shim（与 TS 无关，保留）。
- `scripts/update-catalog.mjs`（catalog:update）、`scripts/dev-plugin-marketplace-server.mjs` / `build-plugin-marketplace-cdn.mjs`（plugin marketplace）：与 src 无关的独立工具脚本，保留。
- `retired/kimi-code-src/`：原 `src/`（TS 入口、i18n、utils、constant、migration、native、feedback、generated 等全部过渡态宿主逻辑），仅存档，不回引。

## 约束（仍有效）

- 本应用只能通过 `@moonshot-ai/kimi-code-sdk` 消费核心能力，禁止直接 import `@moonshot-ai/agent-core`（已退役）。
- 新逻辑不得写进本目录 TS——一律写 Rust（kimi-cli / kimi-tui / kimi-agent）。
- 修本目录 TS bug 前，先核对 Rust 侧（kimi-cli / kimi-agent）是否已有等价能力或修复。

## General Coding Requirements

- For optional object properties, pass `undefined` directly — do not use conditional spread.
- Optional object properties do not need to additionally allow `undefined` in the type.
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Except for a package's own `index.ts`, other `index.ts` files should prefer `export * from './module'`.
