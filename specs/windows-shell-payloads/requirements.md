# Requirements — Windows 双载荷 shell（bash + pwsh）与 PowerShell 原生执行

本 spec 记录 2026-10 决定做的 Windows shell 能力补齐：**钉版 bash / pwsh 双载荷**（消除对系统 Git Bash 的硬依赖）与 **PowerShell 原生工具**（绕开"bash 里跑原生 PS"的编码故障面）。
每一项需求都挂在可复现的背景事实上，不包含"观察项"。

## 目标

1. Windows 主机没有 Git Bash / MSYS2 时，Bash 工具仍能工作：钉版 bash 载荷兜底，探测链自动找到它。
2. PowerShell 任务不再从 bash 里调 `powershell.exe` / `pwsh.exe`（那条路编码必坏），而是走一个**直连 spawn** 的 PowerShell 工具，输出固定 UTF-8。
3. 两个载荷都以钉版 + 哈希校验的方式供给，装到 `<kimi-home>/shells/`，可查状态、可单独补齐。

## 受众

维护 `packages/agent-core-v2/src/_base/execEnv`（shell 探测）、`packages/agent-core-v2/src/agent/tools/os`（执行工具）与 `apps/kimi-code/src/cli`（子命令）的开发者。
读这份文档是为了知道：需求边界在哪、每条需求的验收断言是什么。

## 背景事实（均已复现，证据保留在 design.md）

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | Bash 工具以 `bash -c "cd '<cwd>' && <cmd>"` 拉起进程，输出按 UTF-8 解码 | `packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts:156-171`、`process-task.ts` `observeProcessStream`（`setEncoding('utf8')`） |
| F2 | Windows 上 bash 只认外部 Git Bash / MSYS2，找不到即 `SHELL_GIT_BASH_NOT_FOUND`，用户必须自装 | `packages/agent-core-v2/src/_base/execEnv/environmentProbe.ts:136-200`、`hostEnvironmentService.ts:55-61` |
| F3 | 中文 Windows（codepage 936）上，`powershell.exe` 5.1 与 `pwsh.exe` 7 的**重定向** stdout 都输出 GBK 字节；按 UTF-8 解码即乱码 | 实测 hexdump（design.md「复现」） |
| F4 | 在 PowerShell 命令前置 `[Console]::OutputEncoding=[Text.UTF8Encoding]::new()` 后，5.1 与 7 均输出合法 UTF-8 | 实测 hexdump（design.md「复现」） |
| F5 | 工具注册走 `registerAgentToolService`（`packages/agent-core-v2/src/agent/toolRegistry/toolContribution.ts`），支持 `when` 与 `requiredRuntimeCapabilities` 门控 | 现有工具同模式 |

## 需求

- **R1 钉版载荷清单**：仓库内有一份机器可读清单，为 bash、pwsh 各钉一条 win32-x64 载荷：版本、下载 URL、完整性哈希、解包后可执行文件的相对路径、许可与源码获取指引。载荷二进制**不进 git**。
- **R2 供给（provision）**：下载 → 校验哈希 → 解包 → 原子落盘到 `<kimi-home>/shells/<kind>-<version>/`，并写 `<kimi-home>/shells/<kind>.json` 状态文件（版本、哈希、exe 路径、校验时间）。哈希不符即拒绝安装并清理下载物；重复供给同版本幂等。
- **R3 状态（ladder）**：一条命令输出每个载荷的状态（`missing` / `verified` / `corrupt`）、来源链（system / payload / none）与 exe 路径；对已安装载荷可重新校验哈希。
- **R4 bash 探测链兜底**：`KIMI_SHELL_PATH` > 系统 Git Bash / MSYS2（现行为不变）> **已供给 bash 载荷** > `SHELL_GIT_BASH_NOT_FOUND`。错误信息与 i18n 的 `shellNotFoundAction` 文案都必须给出供给指引（`kimi shells provision`）。
- **R5 PowerShell 工具（仅 Windows）**：新增工具直连 spawn PowerShell，**不经 bash**；输入为 `command` / `cwd` / `timeout`（形状对齐 Bash 工具）；脚本经 `-EncodedCommand` 注入 UTF-8 编码前置；输出按 UTF-8 解码并把 CRLF 归一为 LF；退出码如实透传。
- **R6 pwsh 解析链**：`KIMI_PWSH_PATH` > 系统 `pwsh`（PATH 与 `C:\Program Files\PowerShell\7\pwsh.exe`）> 已供给 pwsh 载荷 > Windows PowerShell 5.1（`powershell.exe`）。链上每一级都要在工具描述与状态输出中可见。
- **R7 安全边界**：不修改系统 PATH、不替换宿主 shell、不动用户的默认终端；供给只写 `<kimi-home>/shells/`；下载必须是 https 且钉版哈希强制校验；GPL 的 bash 以独立载荷分发，清单里保留源码获取指引；主包（MIT）不含载荷二进制。

## 排除项

- **MSYS DLL import 重定向 / IPC 代理**（dsh-ops 的深度桥）：本版不做。故障面由"直连 spawn + 编码前置"绕开，不是把 bash→原生桥修成通用设施。
- **后台长进程托管组件**：已有 `run_in_background` + TaskList/TaskOutput/TaskStop，不重做。
- **Rust 文件工具**：已有内置 Read/Write/Edit/Glob/Grep，不重做。
- **非 Windows 平台**：Linux/macOS 的 shell 探测与工具集不变；PowerShell 工具在非 Windows 上不注册。

## 验收断言（对应 tasks.md）

- A1：清单与哈希校验有单测覆盖（篡改哈希必须拒绝安装）。
- A2：`environmentProbe.test.ts` 覆盖"系统 bash 缺失但载荷存在→用载荷"与"两者都缺→错误含供给指引"两个新分支。
- A3：PowerShell 工具单测覆盖：仅 Windows 注册、`-EncodedCommand` 参数携带编码前置、输出 CRLF 归一、退出码透传。
- A4：`kimi shells status` / `kimi shells provision` 在本机真实运行一次，产物落在 `<kimi-home>/shells/`，状态输出可读。
