# 从 kimi-cli 迁移

::: warning 迁移功能已移除
交互式 `kimi migrate` 命令及其首次运行时的自动提示都已删除。旧版 Python/uv 安装目录下的 `~/.kimi/` 数据不会被读取或删除——它原样保留——但 Kimi Code CLI 不再自动导入其中的配置、MCP 服务或历史会话。
:::

Kimi Code CLI 经历了一次大版本升级：从 Python/uv 重写为 TypeScript，当前版本运行在 Bun 上，安装更简单、启动更快，终端界面也重新设计过。

## 新版本的变化

- **不再需要 Python / uv**：改用 TypeScript 重写，无需 Python 环境，安装更简单
- **原生二进制，开箱即用**：启动更快，占用更轻
- **重新设计的终端界面**：更顺滑、响应更快

## 手动迁移配置

由于没有导入器，需要你把仍然要用的设置手动搬过来。两个配置文件格式并不相同，所以这是「读一遍、重写一遍」，而不是复制粘贴。

**配置文件。** 打开旧版的 `~/.kimi/config.toml`（或更早的 `.json`），把还需要的内容重新写进新的 `~/.kimi-code/config.toml`。常见的是 provider、模型别名和 MCP 服务；当前 schema 见[配置文件](../configuration/config-files.md)，provider 块的结构见 [Provider](../configuration/providers.md)。

**MCP 服务。** 把每个服务的 `command`、`args`、`env`（或 `url`）抄进新的 `[mcp_servers]` 表。启动 Kimi Code 后用 `/mcp` 可以看到实际加载了哪些服务以及连接失败的原因。

**Skills。** 旧版 skill 是若干 Markdown 文件目录。把它们复制到 [Agent Skills](../customization/skills.md) 中记录的目录之一——项目内的 `.agents/skills/`，或用户级的 `$KIMI_CODE_HOME/skills/`。

**凭据无法迁移。** 旧版 home 下的 OAuth 登录状态不会被新 CLI 读取，切换后需要执行一次 `/login`。使用自身授权机制的 MCP 服务也需要重新授权。

## 历史会话

旧版会话无法导入。它们仍以普通文件的形式留在 `~/.kimi/` 下，旧版 CLI 也照常可用——两套安装互不干扰。新会话会从零开始，存放在 `~/.kimi-code/` 下。
