# Kimi Code CLI — 全面代码审查报告

**日期**: 2026-07-11  
**范围**: `D:\kimi\kimi-code` (15 packages + 4 apps, TypeScript monorepo)  
**审查维度**: Security · Architecture · Code Quality · Testing · Documentation

---

## 总览

| 严重级别 | 数量 | 说明 |
|----------|------|------|
| 🔴 **CRITICAL** | 6 | 必须立即修复 — 安全漏洞 / 数据风险 |
| 🟠 **MAJOR** | 16 | 应在下一个 release 前修复 |
| 🟡 **MINOR** | 12 | 建议修复，提升质量 |
| 🔵 **NIT** | 7 | 可选改进 |

---

## 🔴 CRITICAL（6 项）

### C1. 权限系统：RPC 缺失时静默自动批准所有工具

- **文件**: `packages/agent-core/src/agent/permission/index.ts:186-189`
- **类别**: A01:2021 Broken Access Control
- **风险**: 当 `agent.rpc?.requestApproval` 为 falsy 时，所有返回 `{ kind: 'ask' }` 的策略被静默批准。Subagent 或解耦的 agent 实例会在用户无感知的情况下自动批准所有工具操作。
- **修复**: 改为返回 `{ decision: 'rejected' }` 或至少记录遥测告警。

### C2. Symlink 逃逸检测函数定义但从未被调用

- **文件**: `packages/agent-core/src/tools/policies/path-access.ts:302-339`
- **类别**: A01:2021 Broken Access Control
- **风险**: `resolveSymlinkEscape()` 通过 `fs.realpath` 检测 symlink 目标是否指向工作区外。但 **Write 和 Edit 工具均未调用它**。攻击者可在工作区内植入指向 `/etc/passwd` 的 symlink，通过 Write/Edit 覆写任意文件。
- **修复**: 在 `WriteTool.execution()`（`ensureParentDirectory` 调用前）和 `EditTool.execution()`（`readText` 前）调用 `resolveSymlinkEscape`。

### C3. Hook 执行器使用 `shell: true` 配合用户提供的命令

- **文件**: `packages/agent-core/src/session/hooks/runner.ts:14-29, 67`
- **类别**: A03:2021 Injection (Command Injection)
- **风险**: `buildHookSpawnOptions` 无条件设置 `shell: true`。钩子命令（来自配置文件）被直接传给 `spawn()`，在 Windows 上 `cmd.exe` 会解释 `&`、`|`、`&&` 等 shell 元字符。
- **修复**: 若钩子命令是单个二进制，移除 `shell: true` 并使用参数数组。若必须用 shell，添加元字符验证/净化。

### C4. `KimiCore` 无 `dispose()` 方法

- **文件**: `packages/agent-core/src/services/coreProcess/coreProcessService.ts:152-159`
- **类别**: 资源泄漏
- **风险**: `CoreProcessService.dispose()` 仅翻转 `_disposed` 标志，但 core 内部的 session stores、MCP 连接、file watchers、plugin manager 永不被释放。进程退出前持续泄漏资源。
- **修复**: 为 `KimiCore` 添加 `dispose()` 方法，在 `super.dispose()` 前调用。

### C5. `kimi-native-tools` — 17 个 Rust 源文件零测试覆盖

- **文件**: `packages/kimi-native-tools/src/` (bash.rs, grep.rs, glob.rs, read.rs, write.rs, edit.rs 等)
- **类别**: 测试缺失
- **风险**: Rust 原生工具承担 Bash/Grep/Glob/Read/Write/Edit 等核心操作的性能加速路径，零测试意味着回归风险极高。
- **修复**: 为每个工具模块添加 Rust `#[cfg(test)]` 单元测试。

### C6. `ILogService` 在 agent-core 中未注册默认实现

- **文件**: `packages/agent-core/src/services/logger/logger.ts:5-17`
- **类别**: 架构缺陷
- **风险**: 任何注入 `@ILogger` 的服务在独立使用（如测试）时 DI 解析失败。AGENTS.md 注明 "adapter lives in server"，但没有 fallback。
- **修复**: 提供 `NoopLogService` 默认单例。

---

## 🟠 MAJOR（16 项）

### M1. Plan 模式下 Bash 未受限

- **文件**: `packages/agent-core/src/agent/permission/policies/plan-mode-guard-deny.ts:10-48`
- **风险**: Plan 模式下 Write/Edit 被硬拒绝，但 Bash 未被限制。模型可通过 `echo "content" > file` 绕过写保护。
- **修复**: Plan 模式激活时将 Bash 加入 `PlanModeGuardDeny`。

### M2. `Agent` 工具在默认批准集中

- **文件**: `packages/agent-core/src/agent/permission/policies/default-tool-approve.ts:15`
- **风险**: Manual 模式下，模型可不必用户批准即孵化 subagent。Subagent 继承权限设定，可静默读取代码库全部内容。
- **修复**: 从 `DEFAULT_APPROVE_TOOLS` 移除 `Agent`，或添加 mode-aware 策略。

### M3. Yolo 模式下无默认 Bash 危险命令拒绝规则

- **文件**: `packages/agent-core/src/agent/permission/policies/default-tool-approve.ts`
- **风险**: Yolo 模式下所有未被 deny 规则匹配的 Bash 命令自动批准。默认无 deny 规则针对 `rm -rf /*` 等危险模式。
- **修复**: 预置针对已知危险模式（`rm -rf /`、格式化、覆写设备文件等）的 deny 规则。

### M4. Grep/Glob 敏感文件过滤依赖后处理而非策略链

- **文件**: `packages/agent-core/src/tools/builtin/file/grep.ts:186`, `glob.ts:127`
- **风险**: Grep/Glob 设置 `checkSensitive: false`，依赖 rg 预过滤 + 后处理。若后处理有 bug，敏感内容泄露。策略级别的 `SensitiveFileAccessAsk` 无法拦截 searchPath 类型的工具访问。
- **修复**: 将后处理提取为独立策略，统一在策略链中执行。

### M5. `fileLaunch.ts` 使用 `shell: true` 配合环境变量编辑器命令

- **文件**: `packages/server/src/lib/fileLaunch.ts:23-26, 146-149`
- **类别**: A03:2021 Injection
- **风险**: `openFileCommandFor` 将 `EDITOR`/`VISUAL`/`KIMI_CODE_EDITOR` 环境变量值原样拼入 shell 命令字符串。恶意环境变量值可注入任意命令。
- **修复**: 重构为参数数组化 `spawn`，不依赖 shell 解析。

### M6. Read 工具不扫描文件内容中的密钥

- **文件**: `packages/agent-core/src/tools/builtin/file/read.ts:263-321`
- **类别**: A02:2021 Cryptographic Failures
- **风险**: Read 仅按**文件名**阻断敏感文件访问。若用户将 token 放在 `config.json`（不匹配敏感文件名模式），Read 完整返回内容给模型。`sensitive.ts:110` 已有 `looksLikePrivateKeyContent` 函数但 Read 未调用。
- **修复**: 在 `execution` 返回结果前调用 `looksLikePrivateKeyContent`，命中时返回 `[Sensitive content blocked]`。

### M7. OAuth API 错误消息可能回显服务端泄露的 token

- **文件**: `packages/oauth/src/api-error.ts:44-56`, `packages/oauth/src/oauth.ts:25-27`
- **类别**: A02:2021
- **风险**: `readApiErrorMessage()` 将 OAuth 服务器错误响应体中的 token 可能回显到 `OAuthError.message` 中，未经格式化脱敏。
- **修复**: 对返回值调用 `redactString()`。

### M8. SessionService → PromptService 惰性 DI 无空值保护

- **文件**: `packages/agent-core/src/services/session/sessionService.ts:119-121`
- **类别**: 架构缺陷
- **风险**: 为打破循环依赖而使用 `invokeFunction` 惰性解析，若注册失败返回 `undefined`，后续调用 NPE。
- **修复**: 添加 null-guard 和防御性检查。

### M9. 插件系统无沙箱隔离

- **文件**: `packages/agent-core/src/plugin/manager.ts:249, 260`
- **类别**: 架构风险
- **风险**: 插件 hook 和 MCP 进程以完整 OS 权限执行。恶意插件可读写任意文件、孵化进程。
- **修复**: 至少文档化信任模型；长期考虑 capability allowlist 或沙箱策略。

### M10. 实验性 flags 使用全局 singleton 而非 scoped resolver

- **文件**: `packages/agent-core/src/tools/builtin/native-tools.ts:52`, `rpc/client.ts:42`
- **类别**: 架构缺陷
- **风险**: `native_tools` 和 `rpc_microtask` 使用 `import { flags } from '../../flags'`（全局 singleton），而非 Agent 上的 scoped resolver。这意味着 `config.toml` 的 `[experimental]` 覆盖和 master switch 对这两个 flag 失效。
- **修复**: 通过 tool context 注入 scoped resolver。

### M11. 7 处空 catch 块静默吞掉关键错误

- **文件**: `rpc/core-impl.ts:1299`, `logging/sinks.ts:241`, `session/hooks/engine.ts:117,129`, `session/hooks/runner.ts:239,254`, `services/fs/fsGitService.ts:292`
- **类别**: 错误处理
- **风险**: RPC 刷新失败、日志写入失败、hook 回调错误、kill 信号失败 — 全部静默消失，无遥测。
- **修复**: 至少添加 `logger.warn` 调用或注释说明为何吞掉。

### M12. 测试中构造函数绕过类型保护

- **文件**: `packages/agent-core/src/services/oauth/oauthService.ts:91-92`
- **类别**: 类型安全
- **风险**: `OAuthService as any` 绕过构造函数保护以注入 mock。真实构造函数可能执行副作用/初始化逻辑。
- **修复**: 使用 `Partial<OAuthService>` 或重构为可注入工厂。

### M13. MicroCompaction 测试套件整体跳过

- **文件**: `packages/agent-core/test/agent/compaction/micro.test.ts:34`
- **类别**: 测试
- **风险**: `describe.skip` 整个 MicroCompaction 套件 — 上下文管理的关键特性无测试保护。
- **修复**: 修复或删除该套件。

### M14. 55+ 个 Server e2e 测试在 Windows 上被排除

- **文件**: `packages/server/vitest.config.ts`
- **类别**: 测试
- **风险**: Windows 上所有 e2e 测试静默跳过。平台特定回归无法在 CI 中检测。
- **修复**: 修复 flaky polling（见 M15），然后重新启用。

### M15. 20+ e2e 文件使用 busy-wait polling

- **文件**: `packages/server/test/**/*.e2e.test.ts`（20+ 个文件）
- **类别**: 测试质量
- **风险**: 大量 `while (Date.now() < deadline) { await setTimeout(10) }` 模式。在慢/过载 CI runner 上极易 flaky。这是 Windows e2e 被排除的根本原因。
- **修复**: 改为事件驱动等待或 `vi.waitFor`。

### M16. pi-tui 26 个测试文件对 vitest 不可见

- **文件**: `packages/pi-tui/vitest.config.ts`
- **类别**: 测试
- **风险**: vitest config 设置 `include: []`，测试用 `node:test` API。CI vitest 步骤不会执行这些测试。TUI 组件无 CI 覆盖。
- **修复**: 迁移到 vitest API 或在 CI 中添加独立 `node --test` 步骤。

---

## 🟡 MINOR（12 项）

### m1. `protobufjs@7.5.4` 任意代码执行漏洞
- **修复**: Override 到 `>=7.6.3`

### m2. `shell-quote@1.8.3` 命令注入漏洞
- **修复**: Override 到 `>=1.8.4`

### m3. `electron@33.4.11` 累计 16 个 CVE（use-after-free, ASAR bypass 等）
- **修复**: 升级到 `>=38.8.6`

### m4. `tar@6.2.1`（electron-builder 传递依赖）5 个 HIGH CVE
- **修复**: Override 到 `>=7.5.16`

### m5. `fast-uri@3.1.0`、`undici@7.27.1`、`ws@8.20.0`、`react-router@7.14.1`、`vite@5.4.21/8.0.8` 多个 HIGH CVE
- **修复**: 通过 pnpm overrides 统一升级

### m6. `kimi-desktop` 0 测试文件
- **修复**: 添加 smoke test（bootstrap + IPC）

### m7. server-e2e 包仅 6 个测试文件
- **修复**: 明确其范围或迁移 server/test/ 下的 e2e 测试

### m8. `telemetry` 包 2 个测试文件覆盖 9 个源模块
- **修复**: 为 crash handler、transport、systemMetrics 补充测试

### m9. `native_tools` 默认 `true` — 实验性功能默认开启
- **修复**: 文档化或 graduating（转为稳定功能）

### m10. `MicroCompaction` 死代码 — ~120 行注释掉的逻辑
- **修复**: 移除或注释中注明恢复计划

### m11. 31 处 AGENTS.md 可选属性展开模式违规
- **修复**: `{ ...(x ? { x } : {}) }` → `{ x }`

### m12. 无 SDK 编程文档页面；`native_tools` 完全无文档
- **修复**: 添加 `docs/en/reference/sdk.md` 和实验性功能页面

---

## 🔵 NIT（7 项）

- **N1**: `matches-rule.ts:83-84` — 畸形规则静默忽略，应记录 warning
- **N2**: `permission/index.ts:81-87` — session 批准模式无上限累积
- **N3**: `plugin/manager.ts:501` — `isKimiNativeBinary()` 启发式检测脆弱
- **N4**: `flags/registry.ts:38` — `native_tools` 默认 true 的实验性 flag 语义矛盾
- **N5**: AGENTS.md 项目地图缺少 `packages/pi-tui` 和 `apps/kimi-desktop`
- **N6**: `packages/protocol`、`apps/vis` 缺少 README
- **N7**: CONTRIBUTING.md 缺失 `dev:web`、`dev:desktop` 脚本，changeset 指导与 AGENTS.md 冲突

---

## 依赖安全 — 紧急 Override 建议

```json
{
  "pnpm": {
    "overrides": {
      "protobufjs": ">=7.6.3",
      "shell-quote": ">=1.8.4",
      "tar": ">=7.5.16",
      "fast-uri": ">=3.1.2",
      "undici": ">=8.5.0",
      "ws": ">=8.21.0",
      "js-yaml": ">=4.2.0",
      "esbuild": ">=0.25.0",
      "dompurify": ">=3.4.11",
      "postcss": ">=8.5.10",
      "ip-address": ">=10.1.1",
      "qs": ">=6.15.2",
      "@babel/core": ">=7.29.6"
    }
  }
}
```

---

## 值得肯定的设计

- ✅ 架构边界干净：apps 不直接依赖 agent-core，core 无 UI 框架依赖
- ✅ OAuth token 存储设计优秀（atomic write + fsync + 0600 + 路径穿越防护）
- ✅ 日志脱敏完善：结构化日志 key-based + inline regex 双重脱敏，prompt 三层过滤
- ✅ 资源清理纪律良好：addEventListener/removeEventListener 配对，setTimeout/clearTimeout 配对
- ✅ 权限策略链设计有序，19 个策略按优先级排序
- ✅ TypeScript 严格模式：零 `@ts-ignore`，仅 7 处合理的 `as any`
- ✅ 并发模式正确：大量使用 `Promise.allSettled` 防未处理 rejection
- ✅ Bash/Edit/Grep 等核心工具有完善的回归测试（agent-core 有 226 个测试文件）

---

## 优先修复路线

1. **立即** (本周): C1-C5 + 依赖 overrides + M5(fileLaunch)
2. **短期** (下个 release): M1-M4, M6-M11, M13-M14
3. **中期**: M12, M15-M16, m1-m12
4. **长期**: N1-N7
