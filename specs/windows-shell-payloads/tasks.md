# Tasks — Windows 双载荷 shell 与 PowerShell 原生执行

需求见 `requirements.md`（R1–R7），设计见 `design.md`（D1–D5）。每条任务的验收断言在当前代码上**真实失败**，改完后必须真实通过。

依赖关系：**T1 → T2**（探测链兜底读 T1 的状态文件）、**T1 → T3**（pwsh 解析链读 T1 的载荷目录）、**T4 依赖 T2/T3**（子命令调用 T1 的供给库）。T2 与 T3 互不依赖。

全局命令（每个任务的"自测"在此基础上追加）：

```
cd packages/agent-core-v2 && bun test --isolate test/_base/execEnv/ test/agent/tools/os/
```

注意：`packages/agent-core-v2` 是 comment-free zone，新增文件不得有任何注释。

---

## T1 — 载荷清单 + 供给库（R1/R2/R7）

**文件与符号**

- 新增 `packages/agent-core-v2/src/_base/execEnv/shellPayload.ts`：
  `ShellPayloadKind`（`'bash' | 'pwsh'`）、`SHELL_PAYLOAD_MANIFEST`（钉版常量表）、
  `shellPayloadDir(kimiHome, kind, version)`、状态文件 `shellPayloadStatusPath(kimiHome, kind)`、
  `readShellPayloadStatus` / `writeShellPayloadStatus`、`verifyShellPayload`（哈希校验）。
- 新增 `packages/agent-core-v2/src/_base/execEnv/shellProvision.ts`：
  `provisionShellPayload(kind, deps)` —— 下载 → 校验 → 解包 → 原子落盘（临时目录改名），
  哈希不符抛错并清理；同版本重复执行幂等。deps 注入 `fetch`、fs、`extract`（tar.exe）、时钟。

**验收断言**

- 清单每条含 version / url / integrity / exe 相对路径 / license 源码指引。
- 篡改后的哈希必须拒绝安装（`verifyShellPayload` 抛错，provision 清理临时产物，目标目录不残留）。
- 状态文件写入后 `readShellPayloadStatus` 可读回 version/sha256/exePath。

**自测**：`bun test --isolate test/_base/execEnv/shellPayload.test.ts test/_base/execEnv/shellProvision.test.ts`（新增）

## T2 — 探测链兜底（R4）

**文件与符号**

- `packages/agent-core-v2/src/_base/execEnv/environmentProbe.ts` → `locateWindowsGitBash`：
  系统候选全部落空后查 `<kimi-home>/shells/bash-*/bash.exe`（经状态文件），命中即返回；
  否则 `ProbeShellNotFoundError` 的 message 含供给指引。
- `packages/i18n/src/locales/{en,zh}.ts` → `shellNotFoundAction` 文案加供给指引。

**验收断言**

- 系统 bash 缺失 + 载荷存在 → 返回载荷 exe 路径（现有"Git Bash 缺失即抛错"用例仍过：载荷也缺时）。
- 两者都缺 → 错误 message 含 `kimi shells provision`；en/zh `shellNotFoundAction` 同步。

**自测**：`bun test --isolate test/_base/execEnv/environmentProbe.test.ts`

## T3 — PowerShell 原生工具（R5/R6）

**文件与符号**

- 新增 `packages/agent-core-v2/src/agent/tools/os/powershell/powershell.ts`（输入 schema 与接口，
  形状对齐 `bash.ts`）与 `powershellTool.ts`（实现 + `registerAgentToolService`）。
- 解析链（R6）与编码前置（D4）在工具内实现；spawn 直连 `IHostProcessService.spawn`（不经 bash）；
  输出 CRLF→LF 归一；`when` 门控仅 Windows。
- `packages/agent-core-v2/src/index.ts` 注册导入。

**验收断言**

- 非 Windows 不注册（`when` 为假）。
- spawn 参数为 `-NoProfile -NonInteractive -EncodedCommand <b64>`，解码 b64 后含 UTF-8 前置与用户脚本。
- 输出回调里 `\r\n` 已归一为 `\n`；非零退出码如实返回。

**自测**：`bun test --isolate test/agent/tools/os/powershell/powershellTool.test.ts`（新增）

## T4 — CLI 子命令（R2/R3）+ 实机验证（A4）

**文件与符号**

- 新增 `apps/kimi-code/src/cli/sub/shells.ts`：`kimi shells status [--verify]`、
  `kimi shells provision [--bash|--pwsh|--all]`；接进 `cli/commands.ts` / `cli/options.ts` 的既有子命令模式。
- 状态输出含：kind、状态（missing/verified/corrupt）、来源链（system/payload/none）、exe 路径。

**验收断言**

- 本机真实执行 `kimi shells status` 与 `kimi shells provision --all`：产物落在 `<kimi-home>/shells/`，
  状态可读；随后 `kimi shells status --verify` 重算哈希通过。
- PowerShell 工具实机跑 `Write-Output '中文测试ABC'` 得到干净 UTF-8（design.md 验证段）。

**自测**：子命令冒烟 + 全局命令回归。
