# Kimi Code CLI

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://moonshotai.github.io/kimi-code/zh/)

[Documentation](https://moonshotai.github.io/kimi-code/zh/) · [Issues](https://github.com/7723qqq/kimi-code/issues) · [English](README.md)


> ⚠️ **个人实验性 fork**，基于 [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)。与 Moonshot AI 无关，使用风险自负。请勿将本 fork 的 PR 提交到上游。

![Kimi Code 的使用演示](./docs/media/intro.gif)

## 本 Fork 新增特性

相比上游，本 fork 新增：

- **🌐 i18n 国际化多语言支持**：TUI / CLI / Web UI 完整中英双语。所有硬编码英文替换为 `t()` 调用，通过 `/config` 对话框（语言选择器）切换语言。
- **🤖 Team 多 Agent 讨论**：多 Agent 讨论协作工具，Agent 之间可辩论、交叉审查并达成共识后输出。
- **🪟 Windows 启动脚本**：`start-native.bat` 一键启动原生 CLI；`start-desktop.bat` 用于构建并启动本地 vendored 桌面壳（仅当 `apps/kimi-desktop` 存在时可用）。
- **🥖 Bun 唯一打包引擎。** 发布二进制通过 `bun build --compile` 产出单文件构建，由 CI 六平台矩阵（linux/darwin/win32 × x64/arm64）生成。原默认的 Node.js SEA 流水线已退役：pi-tui helper 由打包资产缓存加载、URL-fetch SSRF 语义跨运行时一致（统一捆绑 undici）、自更新感知引擎且仍识别旧 SEA 安装、`/status` 显示 Runtime 行。
- 其他多项修复和体验优化。

如需了解面向贡献者的更深入说明与集成细节，请参见根目录 `DEVELOP.md` → "Fork-specific additions vs upstream"。

## 什么是 Kimi Code CLI

Kimi Code CLI 是一个运行在终端里的 AI 编程 agent，可以帮你读写代码、执行 shell 命令、检索文件、抓取网页，并根据反馈自主决定下一步动作。开箱即用对接 Moonshot AI 的 Kimi 模型，也可指向其他兼容厂商。

## 安装

> ⚠️ **本 fork 不发布安装包与安装脚本。** 下面的官方脚本和 npm 包装到的是**上游 MoonshotAI/kimi-code**，不是本 fork —— 你拿不到上文列出的 i18n、Team 等特性。要运行本 fork，请从源码构建（见下文）。保留这些命令只是为了记录上游的安装方式。

<details>
<summary>上游安装方式（装的是上游，<em>不是</em>本 fork）</summary>

- **macOS / Linux**：

```sh
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

- **Windows（PowerShell）**：

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

</details>

> Windows 上 CLI 已内置 Shell 探测：优先使用 PowerShell 7，其次 Windows PowerShell，然后 Git Bash（如已安装）。如需固定使用某个 Shell（例如 `bash.exe`、`pwsh.exe` 或 `cmd.exe`），请把 `KIMI_SHELL_PATH` 设为其绝对路径。

## 从源码运行本 fork

环境要求：**Bun >= 1.4** 和 **Git**。不需要 Node.js —— 在这里 Bun 同时是包管理器、运行时和打包引擎。只有 Nix 构建路径（`flake.nix`）仍需要 Node.js >= 24.15.0。

```sh
git clone https://github.com/7723qqq/kimi-code.git
cd kimi-code
git switch norust          # norust 是工作分支，origin/HEAD 指向它
bun install
```

然后运行 CLI：

```sh
bun run dev:local           # 构建 bundle（约 2 秒）并从中运行 CLI
bun run dev:local:watch     # 同上，每次源码变更都重建并重跑
```

Windows 上也可以直接双击 `start-native.bat`，它会启动 CLI。

> ⚠️ **避免使用 `dev:cli-only`。** 该脚本直接执行 `src/main.ts`，而 Bun 1.4.2 不解析 `package.json` 里的 `imports` 通配符 `"#/*": "./src/*.ts"`，第一个 `#/` 导入就会以 `Cannot find module '#/kimi-harness'` 中止。Node 能正确解析这些通配符，但 `main.ts` 在非 Bun 运行时下会硬退出 —— 所以两种运行时都跑不了源码路径。请用 `dev:cli`（转到 `scripts/dev.mjs`）或 `dev:local`（先打包，tsdown 会把每个 `#/` 说明符内联）。

## 快速开始

进入项目目录并启动交互界面：

```sh
cd your-project
bun run dev:local -- --cwd .
```

首次启动时，在 Kimi Code CLI 里输入 `/login`，选择 Kimi Code OAuth 或 Moonshot AI Open Platform API 密钥登录。登录完成后，可以先让它熟悉项目：

```
帮我看一下这个项目的目录结构，简单介绍一下每个目录是做什么的
```

## 核心特性

- **单二进制分发** 上游提供一行命令安装，不需要预装 Node.js，不用折腾 PATH，也不会和全局模块冲突。（本 fork 不发布二进制，请从源码构建。）
- **极速启动** TUI 在毫秒级就绪，开一个新会话没有任何心智负担。
- **精致的 TUI 体验** 端到端打磨的交互界面，专为长时间、专注的 Agent 会话优化。
- **视频也能输入** 把屏幕录像、演示视频拖进对话，让 Agent 看那些难以用文字描述的东西——把参考片段做成 LUT、把长视频剪成短视频、把录屏变成代码，等等。
- **AI-native 的 MCP 配置** 通过 `/mcp-config` 对话式添加、编辑、认证 MCP 服务器，无需手写 JSON。
- **丰富的插件生态** 从插件市场或任意 GitHub 仓库安装 skills、MCP 服务器和数据源，每次安装都会标明来源的信任级别。
- **子 Agent 聚焦并行工作** 内置 `coder`、`explore`、`plan` 子 Agent 在隔离上下文中处理子任务，主对话保持清爽。
- **生命周期 hooks** 在关键节点执行本地命令：拦截高风险工具调用、审计决策、发送桌面通知，或对接你自己的自动化脚本。
- **编辑器 / IDE 集成（ACP）** 用 `kimi acp` 让 Zed、JetBrains 等任意 [Agent Client Protocol](https://agentclientprotocol.com/) 客户端直接驱动会话。


## 在编辑器里使用（ACP）

Kimi Code CLI 支持 [Agent Client Protocol](https://agentclientprotocol.com/)，ACP 兼容的编辑器 / IDE（Zed、JetBrains……）可以通过 stdio 直接驱动会话。登录一次后，把编辑器指向 `kimi acp` 子命令即可，无需重复登录。

> 从源码运行时？本 fork 不会全局安装 `kimi` 命令，所以要把编辑器指向本 fork 构建出的 bundle。先跑一次 `bun run dev:local`（或 `bun run build`），然后在下面的配置中用 `apps/kimi-code/dist/main.mjs` 替换 `kimi` 命令。

以 Zed 为例，在 `~/.config/zed/settings.json` 中加入：

```json
{
  "agent_servers": {
    "Kimi Code CLI": {
      "type": "custom",
      "command": "kimi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

随后在 Zed 的 Agent 面板新建对话即可。JetBrains 配置与排障见[在 IDE 中使用](https://moonshotai.github.io/kimi-code/zh/guides/ides)，完整能力矩阵见 [`kimi acp` 参考](https://moonshotai.github.io/kimi-code/zh/reference/kimi-acp)。

## 文档

- [快速上手](https://moonshotai.github.io/kimi-code/zh/guides/getting-started)
- [交互与审批](https://moonshotai.github.io/kimi-code/zh/guides/interaction)
- [会话](https://moonshotai.github.io/kimi-code/zh/guides/sessions)
- [在 IDE 中使用（ACP）](https://moonshotai.github.io/kimi-code/zh/guides/ides)
- [配置](https://moonshotai.github.io/kimi-code/zh/configuration/config-files)
- [命令参考](https://moonshotai.github.io/kimi-code/zh/reference/kimi-command)

## 本地开发

```sh
bun install
```

```sh
bun run dev:local     # 从新构建的 bundle 运行 CLI（用它，不要用 dev:cli）
bun run dev:local:watch
bun run typecheck     # TypeScript 检查（会先构建 packages）
bun run lint          # 运行 oxlint
bun run build         # 构建所有 workspace 包
bun run test          # 运行测试（用 `bun run test` 让测试跑在 Bun 上）
```

完整命令参考见 [DEVELOP.md](DEVELOP.md)，完整贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 社区

- [Issues](https://github.com/7723qqq/kimi-code/issues)
- 安全漏洞反馈，请见 [SECURITY.md](SECURITY.md)。

## 致谢

我们的 TUI 构建在 [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui) 之上。我们衷心感谢 `pi-tui` 作者的工作。

## 许可证

基于 [MIT](LICENSE) 协议发布。
