# Design — Windows 双载荷 shell 与 PowerShell 原生执行

需求见 `requirements.md`（R1–R7 与排除项）。本文件写"怎么改、为什么这样改、复现与验证"。

## 复现（改之前的事实）

探针在改代码前于本机（Windows，codepage 936，PowerShell 5.1.26100 + pwsh 7 已装）跑出，探针是一次性命令，仓库不留文件。

**F3 复现**——bash 里跑原生 PowerShell，中文输出不是 UTF-8：

```
$ powershell.exe -NoProfile -NonInteractive -Command "Write-Output '中文测试ABC'" | xxd
00000000: d6d0 cec4 b2e2 cad4 4142 430d 0a         ........ABC..

$ pwsh -NoProfile -NonInteractive -Command "Write-Output '中文测试ABC'" | xxd
00000000: d6d0 cec4 b2e2 cad4 4142 430d 0a         ........ABC..
```

`d6d0 cec4 b2e2 cad4` 是 GBK 的「中文测试」。Bash 工具的输出链（`observeProcessStream` 的
`setEncoding('utf8')`）把它解成 U+FFFD 乱码——这就是"bash 运行原生 ps 会出问题"的机理：
**PowerShell 在 stdout 被重定向时按 `[Console]::OutputEncoding`（= 系统 codepage）写字节**，
跟管道另一端假定的 UTF-8 对不上，且 5.1 与 7 表现一致。

**F4 复现**——编码前置可修，两个版本都成立：

```
$ powershell.exe -NoProfile -NonInteractive -Command \
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Write-Output '中文测试ABC'" | xxd
00000000: e4b8 ade6 9687 e6b5 8be8 af95 4142 430d  ............ABC.

$ pwsh -NoProfile -NonInteractive -Command \
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Write-Output '中文测试ABC'" | xxd
00000000: e4b8 ade6 9687 e6b5 8be8 af95 4142 430d  ............ABC.
```

`e4b8 ad e6 96 87 ...` 是合法 UTF-8。

## 关键决策

### D1 用"直连 spawn + 编码前置"绕开故障面，不做 MSYS 桥

故障只发生在 **bash → 原生 exe** 这一跳（MSYS bash 拉起原生进程，编码/句柄由原生进程按控制台
约定决定）。让 PowerShell 工具**直接 spawn** `pwsh.exe` / `powershell.exe`（`IHostProcessService.spawn`，
与 Bash 工具同一条进程链路），这一跳就不存在；编码前置再把 PowerShell 自身的输出钉到 UTF-8。
dsh-ops 的 MSYS DLL import 重定向 / IPC 代理是把那一跳做成通用设施，代价（自有 DLL、代理进程）
超出本需求，见排除项。

### D2 载荷钉版放在清单里，校验是强制闸

清单是代码内的常量表（版本 / URL / 完整性哈希 / exe 相对路径 / 许可），下载后必须哈希匹配才落盘。
这吸收 dsh-ops 的"钉版 + ladder 校验"模式：**供给一次、之后每次可见来源与校验状态**。
哈希在供给时校验一次并写入状态文件；探测链只信状态文件 + exe 存在性（避免每次会话重算 100MB 级哈希），
`status --verify` 提供重算入口。

### D3 载荷落盘 `<kimi-home>/shells/`，探测链末位兜底

```
KIMI_SHELL_PATH > 系统 Git Bash/MSYS2（现行为不变）> <kimi-home>/shells/bash-<ver>/bash.exe > 报错+供给指引
```

放在末位而不是最前：系统已装 Git Bash 的用户行为零变化（不翻转默认、不改 PATH），缺依赖的用户自动兜底。
pwsh 同构：`KIMI_PWSH_PATH` > 系统 pwsh > 载荷 > Windows PowerShell 5.1。

### D4 PowerShell 工具用 `-EncodedCommand` 承载脚本

`-EncodedCommand` 接收 UTF-16LE Base64，天然避开引号/空格/编码三层转义（仓库已有先例：
`apps/kimi-code/src/utils/open-url.ts`）。注入的前置固定为：

```powershell
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
$OutputEncoding=[System.Text.UTF8Encoding]::new()
$ProgressPreference='SilentlyContinue'
```

用户脚本拼接在前置之后。非交互参数固定 `-NoProfile -NonInteractive`，与 Bash 工具的
`NO_COLOR/TERM=dumb` 同一取向：确定性优先。

### D5 许可隔离

bash 是 GPL、pwsh 是 MIT。两者都以**独立载荷**分发（`<kimi-home>/shells/` 下的下载产物），
主包只含清单与供给代码（MIT），清单为 GPL 载荷保留源码获取指引（R7）。不把二进制提交进 git。

## 模块布局

| 文件 | 职责 |
| --- | --- |
| `packages/agent-core-v2/src/_base/execEnv/shellPayload.ts` | 清单常量、载荷目录解析、状态文件读写、哈希校验（注入依赖，纯逻辑） |
| `packages/agent-core-v2/src/_base/execEnv/shellProvision.ts` | 下载 → 校验 → 解包 → 原子落盘（注入 fetch/fs/解包，网络层可 mock） |
| `packages/agent-core-v2/src/_base/execEnv/environmentProbe.ts` | 探测链加末位兜底分支（R4） |
| `packages/agent-core-v2/src/agent/tools/os/shell/shellToolResults.ts` | Bash / PowerShell 工具共用的结果管线（校验、前台/后台结果包装、超时与终止辅助）——实现期从两工具去重抽出 |
| `packages/agent-core-v2/src/agent/tools/os/powershell/` | PowerShell 工具：输入 schema、解析链（R6）、直连 spawn、编码前置（R5） |
| `apps/kimi-code/src/cli/sub/shells.ts` | `kimi shells status` / `kimi shells provision` 子命令（R2/R3） |

解包统一走 Windows 自带的 `tar.exe`（bsdtar，Win10 1803+ 内置）：zip（pwsh 官方包）与 tgz 都能解，
不引入第三方解压依赖，也不依赖 bash（供给 bash 载荷时机器上可能一个 shell 都没有）。

## 验证

- 单测：清单哈希校验（含篡改拒绝）、状态文件读写、探测链两个新分支、工具参数拼装（编码前置在
  `-EncodedCommand` 载荷里）、CRLF 归一、退出码透传、非 Windows 不注册。
- 实机（A4）：`kimi shells status` 看到两条载荷与来源链；`kimi shells provision` 真实装入
  `<kimi-home>/shells/`；随后 PowerShell 工具跑 `Write-Output '中文测试ABC'` 得到干净 UTF-8 文本。
