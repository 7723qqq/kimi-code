# markstream-vue 列表内代码块生产构建空白 bug：根因与已验证修复方案（存档）

> 2026-06-12 排查归档。修复曾以 pnpm patch 形式落地并验证通过，后按决策**撤销**，改为给仓库提 issue 跟进。本文档保留完整改法，需要时可按文末步骤重新打上。

## 现象

生产构建（`vite build` 产物，如 `kimi server run` 自带的 web UI）中，助手消息里**位于列表项内的代码块**渲染异常：

- 容器卡在 `data-markstream-enhanced="false"`、`data-markstream-pending="true"`
- `.code-editor-container` 为空且 `is-hidden`
- 部分块连 fallback `<pre>` 都没有 → 整块空白；有 fallback 的块显示为带行号的 `code-pre-fallback`

**只有列表/嵌套容器里的代码块中招；顶层代码块正常。`pnpm dev` 开发模式下完全看不出问题。**

探测命令（浏览器 console）：

```js
document.querySelectorAll('[data-markstream-pending=true]')
```

## 根因链

markstream-vue@1.0.1-beta.5（截至归档时为 npm latest）：

1. 嵌套渲染器创建点（`dist/exports.js` 中共 **12 处**：`ListItemNode`、`ParagraphNode`、`NodeChildRenderer`、`HtmlBlockNode`、`NodeRenderer` 自身等）创建子 `NodeRenderer` 时只传 `nodes/index-key/typewriter/fade/show-tooltips` 等，**不透传 `mode` 和 `codeRenderer`**（`isDark`、`codeBlockProps`、themes 同样丢失）。
2. 子渲染器解析生效值：`mode` 缺省回落 `'docs'`；`codeRenderer` 缺省且 `mode==='docs'` → 回落 `'monaco'`。于是列表内代码块被路由到 Monaco 异步组件 `CodeBlockNode.js`，无视 app 配置的 `code-renderer="shiki"`。
3. `CodeBlockNode.js` 内部 `import("stream-monaco")`（可选 peer，本仓库未安装）：
   - **dev**：vite dev 下该 import 解析失败 → 库捕获并警告 `[markstream-vue] Optional peer dependencies for CodeBlockNode are missing...` → 兜底为普通 `<pre>`，内容可读 → **问题被掩盖**。
   - **生产构建**：vite 把缺失的可选 peer 打成空模块 stub（`assets/__vite-optional-peer-dep_stream-monaco_markstream-vue-*.js` 内容为 `const e={};export{e as default};`）→ 动态 import **成功** → Monaco 组件挂载、渲染出完整 shell，但拿到的 monaco API 全是 `undefined` → 初始化静默失败，永不置 `enhanced`，fallback `<pre>` 被编辑器层替换 → **空白**。

## 复现

1. 让助手输出包含"有序列表 → 子弹列表 → ```ts 围栏"的 markdown，例如：

   ````markdown
   1. **第一步**
      - 以前是：
        ```ts
        refreshSessionSidecars(sessionId)
        await syncSessionFromSnapshot(sessionId)
        ```
   ````

2. `pnpm -C apps/kimi-web build`，再起 `npx vite preview`（vite.config.ts 已配 preview 代理，`KIMI_SERVER_URL` 指向任一后端；或直接用 kimi-code 发行包自带 web UI）。
3. 打开该消息：列表内代码块卡 pending/空白；dev 模式同一消息正常。

## 已验证的修复（撤销前 A/B 验证通过）

**思路**：12 处逐一补透传不可维护；改为在 NodeRenderer"解析生效 mode/codeRenderer"的唯一位置加 provide/inject 继承——子渲染器自动继承最近父级的已解析值，顶层无父级时行为与原版完全一致（向后兼容）。

语义（美化版）：

```js
// dist/exports.js · NodeRenderer setup 内（压缩前等价逻辑）
const inherited = inject('__msNodeOpts', null);                 // ← 新增
const mode = computed(() =>
  ['chat','minimal','docs'].includes(props.mode) ? props.mode
  : inherited ? inherited.mode : 'docs');                       // ← 继承
const renderer = computed(() =>
  props.renderCodeBlocksAsPre === true ? 'pre'
  : ['pre','shiki','monaco'].includes(props.codeRenderer) ? props.codeRenderer
  : props.renderCodeBlocksAsPre === false ? 'monaco'
  : inherited ? inherited.codeRenderer                          // ← 继承
  : mode.value === 'docs' ? 'monaco' : 'pre');
provide('__msNodeOpts', {                                       // ← 新增
  get mode() { return mode.value },
  get codeRenderer() { return renderer.value },
});
```

### 重新打补丁的完整步骤

```bash
pnpm patch markstream-vue
# 输出一个临时目录，对其中 dist/exports.js 执行下面的替换脚本，然后：
pnpm patch-commit '<临时目录>'
```

当时实际使用的替换脚本（对压缩产物做精确字符串替换；`R`/`me` 是该文件里 vue `inject`/`provide` 的既有导入别名）：

```python
p = '<临时目录>/dist/exports.js'
src = open(p).read()
old = 'i=E(()=>{return"chat"===(e=o.mode)||"minimal"===e||"docs"===e?e:"docs";var e}),c=E(()=>!0===o.renderCodeBlocksAsPre?"pre":"pre"===o.codeRenderer||"shiki"===o.codeRenderer||"monaco"===o.codeRenderer?o.codeRenderer:!1===o.renderCodeBlocksAsPre||"docs"===i.value?"monaco":"pre"),d=E(()=>r[i.value])'
assert src.count(old) == 1, f'matches: {src.count(old)}'
new = ('__msInhOpts=R("__msNodeOpts",null),'
       'i=E(()=>{return"chat"===(e=o.mode)||"minimal"===e||"docs"===e?e:__msInhOpts?__msInhOpts.mode:"docs";var e}),'
       'c=E(()=>!0===o.renderCodeBlocksAsPre?"pre":"pre"===o.codeRenderer||"shiki"===o.codeRenderer||"monaco"===o.codeRenderer?o.codeRenderer:'
       '!1===o.renderCodeBlocksAsPre?"monaco":__msInhOpts?__msInhOpts.codeRenderer:"docs"===i.value?"monaco":"pre"),'
       '__msPrv=(me("__msNodeOpts",{get mode(){return i.value},get codeRenderer(){return c.value}}),0),'
       'd=E(()=>r[i.value])')
src = src.replace(old, new, 1)
open(p, 'w').write(src)
```

> 注意：替换锚点是针对 1.0.1-beta.5 压缩产物的；换版本后若 assert 失败，按上面"语义"段在新产物里找对应位置改。

### 验证结果（撤销前）

- 未打补丁生产构建：4 个列表内代码块全部 `enh:false / pend:true / 编辑器空`（必现）。
- 打补丁后重建：全部正常（Typescript 头部 + shiki 高亮 + 换行正确）；dev 模式正常；`pnpm -C apps/kimi-web test` 59 个用例全过。

### 已知未覆盖项

补丁只继承 `mode`/`codeRenderer`。嵌套块的 `isDark`、`codeBlockProps`、`themes` 仍未透传（表现为暗色模式下嵌套块主题色略有出入、出现未被禁用的头部按钮），根治需上游补全套透传。

## 上游建议

给 markstream-vue 报 issue：嵌套渲染器（ListItemNode 等 12 处）应继承父渲染器的 `mode`/`codeRenderer`/`isDark`/`codeBlockProps`/`themes`；或 CodeBlockNode 在 stream-monaco 为空 stub（生产构建可选 peer 缺失场景）时应走与 dev 相同的 pre 兜底，而不是卡 pending。
