# kimi-web2 — Kimi Design System web UI (design-first rewrite)

从 Kimi Design System（设计 skill）出发、从零构建的 kimi-web 界面。零依赖、无构建（vanilla
HTML/CSS/JS），可离线以 stub 数据预览设计，也可接上真实 kimi-code 服务器打通前后端。

## 预览（纯设计，无后端）

直接打开 `index.html` 即可（file:// 也可以），所有数据为 stub。

直达参数：`?open=settings | aw | search | models | login` · `?theme=dark`（可叠加）。

## 接真实服务器

服务器 CORS 是白名单制，推荐用自带的同源代理：

```bash
node serve.mjs                # 默认 --port 8101 --target http://127.0.0.1:58627
open "http://localhost:8101/?token=<server token>"
```

`?token=` 只需带一次（会存入 localStorage）。有 token 时 `live.js` 会：

- 拉取真实 workspaces / sessions 替换 stub；
- 打开会话时按需拉取该会话最近 100 条消息并渲染（文本/思考/工具调用）；
- 通过 WS 接收实时事件（回复流、工具进度、回合结束）；
- 发送消息 POST 到该会话（本地新建的 stub 会话仍走 stub 回复）。

无 token 时完全离线，行为与设计稿一致。

## 文件

- `index.html` / `styles.css` / `app.js` — 外壳、渲染、交互（tokens 见 styles.css 顶部）。
- `data.js` — stub 数据 + 轻量 store（`window.Store`）。
- `live.js` — 真实服务器接线（REST + WS 协议说明见文件顶部注释）。
- `serve.mjs` — 零依赖静态 + `/api/v1` 代理（HTTP + WS）。
- `features/` — 自包含功能模块（模型选择、登录、右侧面板、设置四页），约定见
  `features/CONVENTIONS.md`。

## 设计基准

Kimi Design System：kimiDark 中性强调（蓝色仅品牌/数据）、状态用填充非边框、0.5px hairline、
PingFang 优先、圆角 8/10/12/16/20、动效 `cubic-bezier(0.23,1,0.32,1)`、浅色 + 深色。
