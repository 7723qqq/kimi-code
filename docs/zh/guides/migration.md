# 从 kimi-cli 迁移

旧版 kimi-cli 的一次性迁移流程已不再属于 Kimi Code CLI——它随旧版 TypeScript 发行版一并移除，当前基于 Rust 的 CLI 不再包含迁移界面。

::: info 说明
`kimi migrate` 与首次运行时的自动迁移提示已不存在：Rust CLI 只会为 `kimi migrate` 打印提示后退出。
:::

当前 CLI 从 `~/.kimi-code/` 读取配置与会话，永远不会修改或删除旧安装 `~/.kimi/` 下的任何数据。
