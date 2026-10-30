# Progress — Windows 双载荷 shell 与 PowerShell 原生执行

需求见 `requirements.md`，设计见 `design.md`。本文件记录实现与验证的执行证据；不改需求本身。

## 实现状态（2026-10-30）

| 任务 | 状态 | 位置 |
| --- | --- | --- |
| T1 载荷清单 + 供给库 | 完成 | `packages/agent-core-v2/src/_base/execEnv/shellPayload.ts`、`shellProvision.ts` |
| T2 探测链兜底 | 完成 | `packages/agent-core-v2/src/_base/execEnv/environmentProbe.ts`（`provisionedBashCandidates`） |
| T3 PowerShell 工具 | 完成 | `packages/agent-core-v2/src/agent/tools/os/powershell/` |
| T4 CLI 子命令 | 完成 | `apps/kimi-code/src/cli/sub/shells.ts` |

## 验证证据

**单测**（`bun test --isolate`，均绿）：

- `test/_base/execEnv/shellPayload.test.ts` + `shellProvision.test.ts` + `environmentProbe.test.ts`：30 pass
- `test/agent/tools/os/powershell/powershellTool.test.ts`：14 pass
- 套件合计（execEnv + tools/os + bash.test.ts）：163 pass / 0 fail

**钉版哈希对照官方发布值**（设计 D2 的前提）：

- bash：PortableGit-2.56.0.4-64-bit.7z.exe 实测 `b1f3e522…ed1` = git-for-windows 发布说明公布值
- pwsh：PowerShell-7.6.9-win-x64.zip 实测 `ce748480…94d` = 官方 `hashes.sha256` 公布值

**实机（A4）**：

```
kimi shells status            → bash/pwsh 来源链、载荷状态可读
kimi shells provision --all   → bash 2.56.0.4 装入 <kimi-home>/shells/，SFX 解包 + 哈希校验通过
kimi shells provision --pwsh  → pwsh 7.6.9 装入 <kimi-home>/shells/pwsh-7.6.9/pwsh.exe（bsdtar 解 zip）
kimi shells status --verify   → bash: payload=verified，pwsh: payload=verified（exe 哈希重算通过）
载荷 bash 实机执行             → echo/中文输出正常（MINGW64 bash）
```

**编码端到端**（design.md「复现」的对照）：用工具真实参数拼装（`buildPowerShellArgs`）跑本机
pwsh 7 与 Windows PowerShell 5.1，`Write-Output '中文测试ABC'` 输出
`e4b8ade69687e6b58be8af95`（合法 UTF-8）——修复前同一命令输出 `d6d0cec4b2e2cad4`（GBK 乱码）。

## 实现期发现（记录，不改需求）

1. **GNU tar 陷阱**：`tar.exe` 按 PATH 解析会命中 MSYS 的 GNU tar，它把 `C:\Users\…` 当
   远程主机（`Cannot connect to C: resolve failed`）。供给器默认改为钉死
   `%SystemRoot%\System32\tar.exe`（bsdtar，可解 zip），实机复现并修复。
2. **pwsh zip 布局**：官方 zip 根下直接是 `pwsh.exe`，无 `PowerShell-7.6.9/` 包装目录；
   钉版 `exeRelPath` 据此定为 `pwsh.exe`（bash 的 `usr/bin/bash.exe` 经 SFX 实测确认）。
3. **文档失实**：`docs/*/guides/getting-started.md` 与 `docs/*/reference/tools.md` 原先声称
   Windows 上"优先 PowerShell 7 → Windows PowerShell → Git Bash"且可用 `[shell] preference`
   固定。代码事实是仅解析 Git Bash/MSYS2 bash，且 `[shell] preference` 配置注册后无任何
   消费方（死配置）。本次按代码事实改写了这两处文档；`[shell] preference` 的接线是另一件事，
   未做。
4. **镜像实测**（供参考）：`ghproxy.net`（约 78KB/s）与 `gh-proxy.com`（约 51KB/s）可用作
   GitHub Release 镜像前缀；`ghfast.top`、`mirror.ghproxy.com`、`gh.llkk.cc`、`github.moeyy.xyz`
   当时均不可用。走 HTTP 代理时 Git 自带 curl 需要 `--ssl-no-revoke`（供给器已带）。

## 梳理优化（同日第二轮）

- Bash 与 PowerShell 工具的重复结果管线（约 180 行）抽到共享模块
  `agent/tools/os/shell/shellToolResults.ts`，两工具改为委托；bash 全量套件（163）守恒通过。
- 抽取时发现并修复 PowerShellTool 移植引入的偏差：`killSpawnedProcess` 语义应为
  `SIGTERM` + `finally dispose`（bashTool 原行为），此前误写为 `exitCode` 门控的 `SIGKILL`；
  共享模块现以 bashTool 原实现为准（对应"移植要携带原路径的功能清单"审查规则）。
- `decodePowerShellArgs` 从生产模块移入测试（原为测试专用孤儿导出，`orphan-exports` 报错）。
- `check:prompt-ownership`、`orphan-exports`、`check:no-comments`、oxlint（0 error）、
  typecheck（agent-core-v2 / node-sdk）与 164 个相关单测全部复跑通过。

## 未尽事项

- `[shell] preference` 死配置未接线（超出本 spec 排除项之外的另一条需求）。
- `apps/kimi-code/scripts/dev.mjs` 以 `--import file://…` 启动子进程，在 Bun 1.4.4 下报
  `preload not found`（既有问题，与本 spec 无关；验证用等价的 `bun --import <path>` 调用完成）。
