# 在 Web 模式选择器中置灰 Swarm 与目标模式

## 目标
在 `apps/kimi-web` 的聊天输入框“模式”下拉中，临时禁用 Swarm 与目标（Goal）模式，并在两项后显示“暂不支持”。

## 范围
- 仅 Web 端（`apps/kimi-web/src/components/Composer.vue` 的模式菜单）。
- 不涉及 TUI Footer 或状态面板的其他位置。

## 改动点
1. **Composer.vue**
   - 给 Swarm 与 Goal 的 `mode-row` 增加 `disabled` 类。
   - 禁用原有点击、开关、输入框与操作按钮。
   - 在这两行的右侧显示 `modeNotSupported` 文案。
2. **CSS**
   - `.mode-row.disabled`：降低透明度、去掉 hover 高亮、`cursor: not-allowed`。
3. **i18n**
   - `zh/status.ts` 增加 `modeNotSupported: '暂不支持'`。
   - `en/status.ts` 增加 `modeNotSupported: 'Not supported'`。

## 验收标准
- 打开模式菜单后，Swarm 与 Goal 行呈现置灰样式。
- 点击这两行不会触发任何切换或展开操作。
- 中文环境下显示“暂不支持”，英文环境下显示“Not supported”。
