# TUI 全量接入 KAP 设计

## 目标

让 `apps/kimi-code`（TUI / CLI）所有入口默认通过 Kimi Agent Protocol（KAP）连接本地 server，不再默认使用进程内 RPC。KAP 传输能力已在 `@moonshot-ai/kimi-code-sdk` 中实现，本设计解决如何把 TUI 的 harness 创建统一切到 KAP。

## 默认行为

- TUI 默认连接 `http://127.0.0.1:58627`。
- 通过环境变量 `KIMI_CODE_KAP_URL` 可覆盖默认地址。
- 不保留自动 RPC 降级；server 不可达时直接报错退出。
- 暂不在用户配置文件中新增持久化字段，保持最小改动面。

## 架构变更

### 1. 新增内部 helper

在 `apps/kimi-code/src/utils/create-tui-harness.ts` 中封装 harness 创建：

```ts
export function createTuiHarness(options: Omit<KimiHarnessOptions, 'kap'>): KimiHarness {
  return createKimiHarness({
    ...options,
    kap: { serverUrl: process.env['KIMI_CODE_KAP_URL'] ?? 'http://127.0.0.1:58627' },
  });
}
```

### 2. 替换所有调用点

将以下文件中的 `createKimiHarness` 调用改为 `createTuiHarness`：

- `apps/kimi-code/src/main.ts`
- `apps/kimi-code/src/cli/run-prompt.ts`
- `apps/kimi-code/src/cli/run-shell.ts`
- `apps/kimi-code/src/cli/sub/login-flow.ts`
- `apps/kimi-code/src/cli/sub/provider.ts`
- `apps/kimi-code/src/cli/sub/export.ts`
- `apps/kimi-code/src/cli/sub/acp.ts`

现有参数（`identity`、`telemetry`、`uiMode`、`homeDir`、`configPath` 等）原样透传。

### 3. 错误处理

- `createKimiHarness` 内部会在首次 HTTP 交互时暴露连接错误。
- TUI 启动流程通过 `showError` 或日志输出错误，并给出明确提示：无法连接 KAP server，请确认本地 server 已启动。
- 不增加重试或 fallback，避免掩盖 server 未启动的问题。

### 4. 测试影响

- 更新所有 mock `createKimiHarness` 的测试，使其mock `createTuiHarness` 或继续mock底层SDK调用。
- 现有 KAP 相关测试（`packages/node-sdk`）保持不变。

## 非目标

- 不在 CLI 新增 `--kap-url` 命令行参数（先使用环境变量）。
- 不删除 RPC 实现，仅让 TUI 不再默认使用它。
- 不处理 KAP 缺失能力（plugins、reload、export session 等），这些作为已知限制保留。

## 验收标准

1. `pnpm --filter @moonshot-ai/kimi-code typecheck` 通过。
2. `pnpm --filter @moonshot-ai/kimi-code test` 通过。
3. `pnpm -w run lint` 针对改动文件无错误无警告。
4. 本地启动 server 后，TUI 能正常创建 session 并收发事件。
5. 未启动 server 时，TUI 启动失败并给出清晰错误提示。
