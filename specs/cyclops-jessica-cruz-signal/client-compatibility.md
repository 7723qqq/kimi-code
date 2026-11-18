# 官方预构建与本地后端逐项契约审计

## 修复验收（2026-11-17）

以下 G01–G20 和 128 项清单保留为修复前的审计基线，不再代表当前工作树仍然存在全部缺口。本轮只改后端和配套测试，官方 dist-web 仍与 `f082f04a09` 一致。

- G01/G05/G06/G18：技能携带客户端 ID；相同请求并发合并和成功响应短期回放；失败状态保真；主 Agent 的计划与目标覆盖在入队前生效。回放有 10 分钟、1024 项上限，不承诺跨服务器重启的响应回放。
- G02/G04/G15/G16：供应商省略字段保留、显式 null 清空；托管工作区身份保留；raw 配置解包后按可写域严格校验；提问 note 透传。
- G03/G07/G19：显式 Git root 下的相对路径正确解析；已登记绝对文件路径可预览、下载和打开，越界与外部符号链接仍拒绝；目录条目填充请求的 Git 状态。
- G08：有效 Bearer 浏览器请求换取五分钟的 HttpOnly、SameSite=Strict 下载 cookie，仅限同源 GET 文件/媒体下载，逐次重验凭据。普通 REST、Host 内容、WS 不接受该 cookie；主机、端口、过期、撤销和伪造均有回归。
- G09/G10/G11/G20：目标 WS 带身份、完整预算、终止原因；REST/WS 的旧 limited 状态统一投影为 blocked；恢复异常不再伪装 404；仅 WS 订阅边界将升级错误投影为官方终止集合中的 40001，不占用已有 40930；配置事件兼容 changed_fields 和原 changedFields。
- G12/G14：本地预览不安装、不运行命令；GitHub 固定 commit；自定义 ZIP 可无目录摘要，但计算内容摘要，任何已声明摘要仍校验，默认托管远端目录仍严格要求摘要；本地化名称保留。
- G13：按用户明确选择，Host 内容接口的 UTF-16 文本在预览和下载时统一转为 UTF-8，Range/长度/ETag 对应返回表示，TOML 为文本 MIME；二进制与会话原文件下载保留原字节。
- G17：用户选择扩展原地迁移。会话生命周期串行锁、进程间会话锁和 Agent 静默租约保护迁移；保留 session ID/标题/历史，迁移存储与索引并重建本地执行绑定。排队/运行工作、交互、定时任务拒绝迁移；目录移动失败和移动后持久化失败回滚。远端会话要求走环境绑定，不把 Host cwd 当作远端 cwd。

实际官方页面验证：token 连接、托管项目/模型显示、发送并显示假模型回复、刷新恢复历史、TOML 和 UTF-16 中文预览、真实下载导航（未手动给链接添加认证头）。Host UTF-16 fetch 返回 200/text/plain/正确中文。截图见 `alignment-browser.png`。这不是外部 OAuth、云服务、OS 编辑器、所有 128 个 UI 路径的全面实测。

验证数字和清理记录见 `progress.md` 的本轮条目。未提交、未推送，未读取或修改用户真实配置。

## 修复前结论与证据边界

**审计时并未完全对齐。** 已恢复的普通聊天、流式、审批、压缩、fork、undo 主链路可工作；本次逐项追踪仍确认了官方实际 UI 可触发的请求拒绝、配置字段丢失、工作区身份漂移和多根目录文件操作错误。此前“关键链路已实测”不能扩大为“全部接口正确”。

- 客户端：`apps/kimi-code/dist-web/assets/index-Y30h7qWu.js`，SHA-256 `befba224cc7bd58fc769069eb66c60c44a660bea2550eb3e1c61a8e6ea248b37`，与 `f082f04a09` 一致。
- 清点对象：`HMe` 的全部 **128 个方法**，以及 `Tj` HTTP 传输、`DMe` Socket 命令/消费、请求和响应映射器、相关 UI 调用方。AST 清单验证无遗漏、重复或额外方法。
- 逐项分类：**101 项静态匹配，20 项存在直接或条件差异，2 项共用请求封装，5 项辅助/URL方法**，合计128。共用/辅助方法可能继承已列问题（尤其bare下载URL），不是额外的无条件兼容认证。G01–G20是问题类别，与受影响方法数不是一对一关系。
- 证据来自当前工作树的实际处理函数、服务投影和客户端消费逻辑，不把 OpenAPI Schema、路由存在或测试名称当作运行成功证明。
- **匹配**：静态请求/响应契约匹配，不代表外部 OAuth、云服务、下载或 OS 操作已实时验证。
- **差异**：明确列出不兼容和触发条件；**共用/辅助**不豁免其引用的差异。
- 修复前审计只更新本文件，没有修改生产实现或官方产物；之后的修复与浏览器验证范围以上述本轮验收条目为准。先前真实浏览器范围另见 `browser-verification.json`、两张截图及 `progress.md`。
- 下表中的 `R/` = `packages/kap-server/src/routes/`，`P/` = `packages/kap-server/src/protocol/`，`K/` = `packages/agent-core-v2/src/`。客户端 B157/B158 指该固定 bundle 第 157/158 行，具体方法名提供精确定位；UI 特例另列行列。

## 优先修复清单

### G01 · P1 · 官方带技能提示被后端直接拒绝

实际 UI `Xtt` 同时发送 `promptId` 与 `skills`（B559:109837、111940，`pMe` B157:22044）。`R/prompts.ts:211-216` 禁止两者组合，返回 40001，尚未入队。直接调用真实提交处理函数已复现：`prompt_id cannot be combined with a bundled skill submission`。同时影响普通提交和 steer；单独的 activateSkill 接口匹配不代表此路径匹配。

建议在后端复用技能提示 ID 的保留、透传和去重契约，不要求修改官方 composer。

### G02 · P1 · 导入供应商时修改模型表会清除连接地址

官方目录导入对话框在模型表变更后调用 `updateProvider(id,{type,models})`，不传 baseUrl/defaultModel（B1178:108799、109494）。后端 `R/modelCatalog.ts:406-408` 却将省略字段写成 undefined，再 replace 配置。内存配置替身调用真实 PUT 处理函数已确认原 baseUrl/defaultModel 均被删除，返回仍成功；`test/modelCatalogProviderWrite.test.ts:976` 也把这个清除行为固定成旧测试预期。

这不是请求字段拼写问题，而是官方调用方与后端省略值语义冲突。必须区分“保留”“显式清空”和“替换”，不能只验证 PUT 200。

### G03 · P1 · 带 root 的 Git diff 被后端自己拼出的绝对路径拒绝

官方 `getFileDiff(path,{root})` 发送合法 root+相对 path。`K/workspace/workspaceFs/fsService.ts:1431-1437` join 成绝对路径，随后传给 `:1743-1746` 明确拒绝绝对路径的 resolveWithin。`getGitStatus` 同时有 root 和非空 paths 时也走此错路（:1368-1373）。真实方法+Windows path 内存替身复现 `fs.path_escapes`，Git 尚未执行；REST 映射为 41304。

建议修正“已验证根目录+相对路径”的组合边界，不放开任意绝对路径或越界访问。

### G04 · P2 · 托管工作区创建会话时被换成隐式工作区

`HMe.createSession` 发送所选 workspace_id。`R/sessions.ts:240` 读取该工作区，却在 :272 调 createOrTouch(root)，再用 touched.id（:284、302）替代用户所选 ID。`K/app/workspace/workspaceService.ts:89-108` 只复用 wd_*，不会复用同根 wm_*。官方 UI 随后选择响应中的工作区，因而可能跳到隐式项目，并丢掉托管目录集合语义。先前浏览器出现同根两个项目不能视为无害展示差异。

### G05 · P2 · 已接受提示的丢响应重试不幂等

官方 `T3`（B559:56847）遇网络失败后使用同一 envelope/ID 重试，间隔 500/1500ms。`R/prompts.ts:624-645` 对保留 ID 一律冲突；submit 后 dispose 不释放，也不按相同请求回放成功响应。内存调用 reservePromptId 已确认同一已接受 ID 再请求为 prompt.id_conflict。首请求已运行、响应丢失时，客户端可能把重试误报为拒绝并移除乐观消息。

### G06 · P2 · 入队前失败被报成 queued

引擎支持 failed，客户端 `Xtt` 显式处理 status==failed（B559:104031、109837）。`R/prompts.ts:592-597` 把 running/steered/blocked 之外的状态全部投影为 queued，`P/rest-prompt.ts:44` 也无 failed。调用真实 projectPromptSnapshot({state:'failed'}) 已复现 wireStatus='queued'。不等同于轮次启动后模型报错。

### G07 · P2 · 附加根目录能列出，预览/下载/编辑器操作却失败

官方预览控制器 `Tce.x`（B559，约 column 44678 后）对非 cwd 根拼接绝对文件路径，再交给会话 read/download/open/reveal（`ULe` B189:5803）。列表支持已注册绝对根（`fsService.ts:198`），但 read/download/resolvePath 仍使用相对路径专用 resolveWithin（:469、660、675、1743）。即使 allow_external_symlinks=true，也会拒绝绝对路径。真实 resolveWithin 已复现。

这是“授权目录身份如何传递”的契约错配，不能通过删除路径安全校验修复。

### G08 · P2 · 默认鉴权下直接下载链接缺少 Bearer

官方 `getFileDownloadUrl` 生成 API URL，预览组件将它放入隐藏 `<a href>` 并 click（B1125:3883、8074）。URL 构造不附认证头；后端只接受 Authorization，不接受该导航所能携带的其他凭据（`middleware/auth.ts:44-83`）。真实 auth hook 对无头请求返回 HTTP401/40101，对 Bearer 请求放行。

有鉴权的 Blob 获取路径匹配；不是所有媒体展示都失败。getFileUrl/getSessionMediaUrl 同样只是 URL，是否受影响取决于具体消费者。不能为适配链接而无条件绕过后端鉴权。

### G09 · P2 · 目标 WS 推送丢掉身份、预算与终止原因

`MS` B157:25279 支持 goalId、budget、terminalReason；REST 返回完整 snapshot。`transport/ws/v1/agentState.ts:43-53` 只发 objective/status/criterion/统计。客户端目标 store 收到推送会替换 REST 对象。真实 readGoalState + 提取的纯 MS 映射器已复现：goalId 从真实 ID 变为 'goal'，全部预算/剩余额度变 null。

另一个条件差异：本地可重放 budget_limited/usage_limited，MS 将其解码为 null。当前常规预算耗尽走 blocked，故不把该扩展状态问题夸大为每次预算耗尽都隐藏目标。

### G10 · P2 · Socket 恢复失败被伪装为会话不存在

`sessionEventBroadcaster.ts:243-250` 捕获所有 resume 异常后返回 false；`wsConnectionV1.ts:253-255` 最终答复 40401。用抛 wire.version_too_low 的内存 session manager 调用真实 subscribe 已确认。官方将 40401 当终止错误，不再订阅重试，真实升级/持久化原因丢失。

### G11 · P2（错误分支）· wire 升级错误码与官方重试集合冲突

本地 WIRE_VERSION_TOO_LOW=40940，40930 已被 DEFAULT_WORKSPACE_UNAVAILABLE 占用（`P/error-codes.ts:64,76`）。官方 `DMe` 的不可重试集合是 40001/40401/40930，40940 会安排重试。提取 DMe.onSubscribeResponse 后已复现。

G10 会在较早恢复失败时掩盖此问题；当 attach/feed 等分支真正传回 40940，仍会错误重试。不能只改一处数字引入新的本地冲突，应定义边界映射并同步相关消费者。

### G12 · P2（本地/自定义目录）· 列出的插件无法预览

官方插件详情对未安装/版本不一致条目请求 previewPlugin。列表允许无 digest、local/GitHub source（`K/app/plugin/marketplace.ts:279`），preview 却要求 SHA-256 和 HTTP(S) ZIP（`pluginService.ts:354`、`manager.ts:558`）。仓库目录 kimi-datasource 无 digest；dev server 仅改成 ZIP URL，不生成 digest（`apps/kimi-code/scripts/dev-plugin-marketplace-server.mjs:106-119`）。点击详情可失败，安装本身未据此判为失败。符合 managed catalog 严格分发要求的条目不受此项影响；不应通过关闭校验来修复。

### G13 · P2/P3（预览）· Host 文本 MIME/编码边界不一致

Host 内容接口返回原始 bytes（`R/workspaceFs.ts:291-338`）；guessMime('config.toml')='application/toml'（`K/_base/utils/fileMeta.ts:54`），官方 jMe（B158:20964）不承认它是文本。真实 guessMime+jMe 已复现 TOML 被当二进制。已知文本扩展若为 UTF-16仍可获 text MIME，Blob.text() 按 UTF-8解码；session readFile 的 auto 转码不能覆盖 host 端点。

### G14–G19 · 低优先级/条件契约差异

- **G14 · 市场本地化名称丢失**：UI xst 读取 locale[tag].displayName（B561:84482），解析器 `K/app/plugin/marketplace.ts:440-444` 丢弃它。真实 parser 已复现；描述保留，名称回退。当前远端是否含此可选字段未查询。
- **G15 · setConfig.raw 被拒绝**：官方字段映射包含 raw，但 `P/rest-config.ts:53-108` strict patch 无 raw。safeParse 已复现拒绝；未确认普通设置 UI 会发送 raw，不列为当前常用设置必坏。
- **G16 · 提问 note 被拒绝**：wMe 可发 note，`P/interaction.ts:74-84` strict body 不接。普通 answers/method 校验通过，加 note 后只因未知 note 失败。实际点击表单通常无 note。
- **G17 · updateSession.cwd 被忽略**：HMe 会发 metadata.cwd；`R/sessionProfile.ts:14-26` 将其当保留字段滤除，:52-56 还会替换非保留 custom metadata。常规 model/mode/goal 设置走 agent_config，仍匹配。
- **G18 · 单次提示的 plan/goal 选项接受但未应用**：pMe 可发 plan_mode/goal_objective/goal_control，提交处理只应用 model/thinking/permission/swarm/disabled_tools（`R/prompts.ts:272-295`）。主 UI 通常先调用 profile，不能由此声称整个计划/目标模式失效。
- **G19 · listDirectory.includeGitStatus 无效果**：请求字段有定义，实际 list/entry 实现不填 git_status（`K/workspace/workspaceFs/fsService.ts:198,350,1976`）。当前 tree 调用不传该选项，故是可选能力缺口。

### G20 · P3 · 配置变更事件字段命名不一致，但当前消费者不依赖它

后端 `changedFields`（`sessionEventBroadcaster.ts:1023`、`P/events-zod.ts:681`），官方 xMe 读 `changed_fields`（B157:26327）。纯映射复现 changedFields=undefined。然而当前实际 UI 主要使用完整 config，AST 未发现后续对 changedFields 的属性读取；因此是确定的协议漂移，不宣称已造成整个设置界面不刷新。

## 逐项清单：公共方法（4）

| 方法 | 结论 | 请求/消费核对与后端证据 |
| --- | --- | --- |
| `dispose` | 辅助 | 无 HTTP；释放客户端后台队列。与后端无请求契约。B157 HMe/Tj。 |
| `getHealth` | 匹配（回退） | GET /api/v1/healthz；后端 data={ok:true}，客户端 uptime_sec 缺失时回退0。R/registerApiV1Routes.ts:221-245；不是实际 uptime 已实现。 |
| `getMeta` | 匹配 | GET /meta；server_version/server_id/started_at/capabilities/open_in_apps/dangerous_bypass_auth/experimental_flags/backend/web_title 对应。R/meta.ts:24-56，P/rest-meta.ts:32。open_in_apps 当前固定[]，不据此宣称 OS 发现可用。 |
| `connectEvents` | 部分差异 | /api/v1/ws + kimi-code.bearer 子协议正确；帧/重连详见 Socket 表及 G09–G11/G20。B158 connectEvents，start.ts:523-597。 |

## 逐项清单：会话、提示与交互（40）

所有 HMe 方法为 B157/B158；V1 prefix=/api/v1，V2=/api/v2。`Td` 消费 metadata/agent_config/usage 等对象，实际 producer 均提供（R/sessions.ts:1305）。

| 方法 | 结论 | 请求 → 消费响应；后端证据 |
| --- | --- | --- |
| `listSessions` | 匹配 | GET /sessions，before_id/after_id/page_size/busy/include_archive/archived_only/exclude_empty/workspace_id → items.map(Td),has_more。互斥游标及布尔解析对应。R/sessions.ts:130,323,446。 |
| `listSessionsV2` | 匹配 | GET V2 /sessions，sort/page_size/page_token/page/meta.updated_after/meta.updated_before/meta.archived/workspace.id/activity.status/include → items/has_more/next_page_token/total。R/v2/sessions.ts:94,221,542,805。 |
| `listSessionIdsV2` | 匹配（限额） | 同V2，fields=id,archived → id/archived 数组及分页；10000页尺寸允许。R/v2/sessions.ts:130,236,676,789。scan_truncated 未被客户端消费，非无限量保证。 |
| `listSessionGroupsV2` | 匹配 | GET V2，view=by_workspace、group.page_size、meta.has_prompt 及筛选 → groups/workspace/sessions/total/has_more/token。R/v2/sessions.ts:94,542,679,741。 |
| `createSession` | 差异 G04 | POST /sessions {metadata.cwd?,workspace_id?,title?,agent_config.model?} → Td；请求字段接受，但托管工作区ID被替换。R/sessions.ts:224-305。 |
| `getSession` | 匹配 | GET /sessions/{id} → Td；40401；字段对象、ISO时间与可空值对应。R/sessions.ts:460,475,495,1305。 |
| `updateSession` | 条件差异 G17 | POST /sessions/{id}/profile {title?,metadata.cwd?,agent_config?} → Td；model/thinking/permission/plan/swarm/tower/base/goal字段已应用，cwd被过滤。R/sessions.ts:554-592；R/sessionAgentConfig.ts:97；R/sessionProfile.ts:14,52。 |
| `getSessionGoal` | 条件差异 G09 | GET /sessions/{id}/goal → 完整snapshot/null；常规4状态适配MS，扩展limited状态被MS丢弃。R/sessions.ts:845-861，P/goal.ts:3。 |
| `editSessionGoalObjective` | 条件差异 G09 | PATCH 同路径 {objective} → snapshot/MS；编辑保持身份，扩展状态解码问题相同。R/sessions.ts:874-899，P/rest-session.ts:138。 |
| `evaluateSessionRating` | 匹配 | POST /rating {op:evaluate,turn_id} → appearance:null或{id,survey}，kMe正确映射；真实最新结束轮次校验。R/sessionRating.ts:29-65；P/rest-session-rating.ts:3。 |
| `reportSessionRating` | 匹配 | POST /rating，shown/abandon + appearance_id，respond另含response → null；客户端不读null字段。R/sessionRating.ts:65；P/rest-session-rating.ts:13。 |
| `getTurnFileChanges` | 匹配 | GET /file-history/changes?turn_number → recorded/changes；false译为unrecorded，其余行对应。R/fileHistory.ts:31-54；P/rest-file-history.ts:3,21。 |
| `getTurnFileContent` | 匹配 | GET /file-history/content?turn_number&path&phase=start/end → content:null或{version,content?,binary?}，返回条目而非直接字符串。R/fileHistory.ts:73-97；P/rest-file-history.ts:12,37。 |
| `getSessionWarnings` | 匹配 | GET /warnings → warnings[{code,message,severity}]，缺失回退[]。R/sessions.ts:915-938。 |
| `archiveSession` | 匹配 | POST /sessions/{id}:archive {} → archived:true。R/sessions.ts:660,996,1152。 |
| `restoreSession` | 匹配 | POST :restore {} → Td；恢复归档后再投影。R/sessions.ts:1135；K/workspace/sessionLifecycle/sessionLifecycleService.ts:588。 |
| `reloadSession` | 匹配 | POST :reload {} → Td；运行/压缩忙拒绝40901。R/sessions.ts:1181,1191,1227,1259。 |
| `takeoverSessionLock` | 匹配 | POST :takeover {} → taken_over:true，被客户端丢弃；先检查存在。R/sessions.ts:1163；P/rest-session.ts:177。 |
| `deleteSession` | 匹配 | POST :delete {} → deleted:true；真实manager删除，未知会话报错。R/sessions.ts:1174；K/app/sessionManager/sessionManagerService.ts:366。 |
| `archiveSessions` | 匹配 | POST V2 /sessions:archive {ids} → results[{id,ok,error?}],succeeded,failed；≤5000唯一ID。R/v2/sessions.ts:263,496,828。 |
| `restoreSessions` | 匹配 | POST V2 /sessions:restore {ids} → 同batch；恢复archived并保留逐ID错误。R/v2/sessions.ts:496,518,828。 |
| `getAgentTurns` | 匹配 | GET /sessions/{id}/agents/{agent}/turns?before_ordinal&page_size → turns/has_more；1–200，页内旧到新，ID/ordinal语义对应。R/conversation.ts:21-58；services/conversation/conversationFeed.ts:192。 |
| `exportSession` | 匹配 | POST /export {web_log?,desktop?:true} → application/zip+Content-Disposition；客户端ZIP解析、desktop旧端回退对应；web_log上限256KiB。R/sessionExport.ts:43,105,136；P/rest-session.ts:57,64。 |
| `submitPrompt` | 差异 G01/G05/G06/G18 | POST /prompts；pMe字段映射正确，技能+ID拒绝、重试冲突、failed误报及单次模式未应用。R/prompts.ts:189-373,592,624。 |
| `steerPrompt` | 差异 G01/G05/G06/G18 | POST /steer 使用同handler，steerIfActive生效；共享缺口。R/prompts.ts:189,363,420。 |
| `submitPromptToPath` | 共用（继承差异） | pMe序列化 content/metadata/agent/model/thinking/permission/plan/swarm/goal/prompt_id/skills；消费 prompt_id/user_message_id/origin?/status。R/prompts.ts:350-373,603；P/rest-prompt.ts:24。 |
| `steerPrompts` | 匹配 | POST /prompts:steer {prompt_ids} → steered/prompt_ids；非空、队列竞态40402处理对应。R/prompts.ts:452-472；K/agent/loop/loopService.ts:397。 |
| `abortPrompt` | 匹配 | POST /prompts/{id}:abort，无body → aborted；40402丢队列竞态可处理，遗留40903 allowlist不与本地40931冲突。R/prompts.ts:485-544。 |
| `abortSession` | 匹配 | POST :abort {} → aborted:true；main loop cancel，空闲是no-op确认。R/sessions.ts:1079；P/rest-session.ts:190。 |
| `compactSession` | 匹配 | POST :compact {instruction?} → {}，启动而非等待完成；并发40910。R/sessions.ts:1045；P/rest-session.ts:148。 |
| `undoSession` | 匹配 | POST :undo {turn_id,agent_id?} → removed_turn_ids；字符串conversation ID，main默认；40422/40421区别不触发该客户端特殊分支。R/sessions.ts:1065；services/conversation/conversationFeed.ts:166。 |
| `generateSessionTitle` | 匹配 | POST /title/generate {force?:true,source?} → title；user_prompts/first_turn/digest对应，客户端任何错回退null。R/sessions.ts:604-648。 |
| `forkSession` | 匹配 | POST :fork {title?,turn_index?} → Td；turn_index来自turn_number而非ordinal/string ID。R/sessions.ts:1010；P/session.ts:98；K/workspace/sessionLifecycle/internal/forkTurnSlice.ts:133。 |
| `createChildSession` | 匹配 | POST /children {title?} → Td，parent_session_id与child kind生产正确。R/sessions.ts:791-815；K/workspace/sessionLifecycle/sessionLifecycleService.ts:876。 |
| `listChildSessions` | 匹配（限额） | GET /children → items.map(Td)；后端≤100非归档子会话，客户端不消费has_more，非无限列表。R/sessions.ts:722-779。 |
| `startBtw` | 匹配 | POST :btw {} → agent_id，映射agentId；实际fork main，校验model readiness。R/sessions.ts:1087；K/features/btw/btwService.ts:39。 |
| `respondApproval` | 匹配 | mMe → POST /interactions/{id} {kind:approval,decision,scope?,feedback?,selected_label?} → outcome/ended_at；字段转回引擎。P/interaction.ts:64；R/interactions.ts:99。 |
| `respondQuestion` | 条件差异 G16 | wMe → {kind:question,answers,method?,note?}；答案ID和类型转换匹配，defined note遭strict拒绝。P/interaction.ts:74；R/interactions.ts:130。 |
| `dismissQuestion` | 匹配 | {kind:question,dismissed:true} → dismissed/ended_at，answers/dismissed异或正确。P/interaction.ts:74；R/interactions.ts:108。 |
| `respondInteraction` | 共用（继承G16） | 编码session/interaction ID，POST discriminated body → outcome/endedAt；40404/40902/会话归属匹配。R/interactions.ts:42-130。 |

## 逐项清单：模型、配置、认证与远程控制（35）

| 方法 | 结论 | 请求 → 消费响应；后端证据 |
| --- | --- | --- |
| `getRemoteControlStatus` | 匹配 | GET /remote-control → enabled/state/off-starting-on-stopping/url/device_id/device_name/error/conflict?原样。R/remoteControl.ts:77,382；P/rest-remote-control.ts:3。 |
| `setRemoteControlEnabled` | 匹配 | POST同路径 {enabled} → status；strict、40001/40928 structured holder对应。R/remoteControl.ts:111；P/rest-remote-control.ts:22。 |
| `listRemoteControlDevices` | 匹配 | GET /remote-control/devices → devices[]/max_devices?，device_id/alias/platform/client_version/local_base_url/created_at/updated_at/last_remote_access_at/status均生产。R/remoteControl.ts:202；packages/remote-control/src/device-client.ts:81,238。 |
| `renameRemoteControlDevice` | 匹配 | PATCH /devices/{id} {alias}（trim后1–50）→ ok:true，被忽略。R/remoteControl.ts:221；P/rest-remote-control.ts:48,53。 |
| `deactivateRemoteControlDevice` | 匹配 | POST /devices/{id}/deactivate {} → ok:true；本机设备停隧道协调存在。R/remoteControl.ts:248。 |
| `deleteRemoteControlDevice` | 匹配 | DELETE /devices/{id} → ok:true非204，客户端只await；本机清理存在。R/remoteControl.ts:293。 |
| `getMcpAuthStatuses` | 匹配 | GET V2 /mcp/auth-statuses?verify=false&cwd? → name/authStatus数组；strict query、6种状态对应。R/v2/mcp.ts:62,142,405。 |
| `beginMcpAuth` | 匹配 | POST V2 /mcp/auth:begin?cwd?，global{name}/plugin{pluginId,serverName} locator → authorization-required{flowId,authorizationUrl}或already-authorized。R/v2/mcp.ts:85,161,434。 |
| `completeMcpAuth` | 匹配（调用方超时） | POST V2 /mcp/auth:complete {flowId,timeoutMs?} → null；signal是传输选项非body。实际UI传900000ms；方法省略值时HTTP默认30s短于service15min。R/v2/mcp.ts:99,461；K/app/mcpManagement/mcpManagementService.ts:50,259。 |
| `cancelMcpAuth` | 匹配 | POST V2 /mcp/auth:cancel {flowId} → null；未知非空ID为幂等no-op。R/v2/mcp.ts:109,496；mcpManagementService.ts:289。 |
| `resetMcpAuth` | 匹配 | POST V2 /mcp/auth:reset?cwd? +同locator → null；实际invalidate指定server。R/v2/mcp.ts:521；mcpManagementService.ts:306。 |
| `listModels` | 匹配 | GET /models → items.map(SMe)：provider/model(alias ID)/display_name/max_context_size/capabilities/support_efforts/default_effort。R/modelCatalog.ts:152；K/llm-adapter/model/catalog-service.ts:209,391。 |
| `listProviders` | 匹配 | GET /providers → items.map(vg)：id/type/base_url?/default_model?/has_api_key/status/models?。R/modelCatalog.ts:213；K/llm-adapter/model/catalog.ts:143。 |
| `getProvider` | 匹配 | GET /providers/{id} → vg +非undefined api_key转apiKey；缺失/空key省略，非null。R/modelCatalog.ts:602,621；P/rest-modelCatalog.ts:18。 |
| `addProvider` | 匹配 | POST /providers {id,type,models[],api_key?,base_url?,default_model?} →201 provider裸条目供vg；nested model字段/重复/default约束对应。R/modelCatalog.ts:232-316；P/rest-modelCatalog.ts:34,78。 |
| `updateProvider` | 差异 G02 | PUT /providers/{id} {type,models,new_id?,api_key?,base_url?,default_model?} → {provider}；key省略保留，但base/default省略清除，与目录导入UI冲突。R/modelCatalog.ts:326,395-408,481-501。 |
| `deleteProvider` | 匹配 | DELETE /providers/{id} → 空204；Tj显式支持204，HMe合成deleted:id。R/modelCatalog.ts:641-696。 |
| `listCatalogProviders` | 匹配 | GET /catalog/providers → items.map(Ij)：id/name/wire_type/base_url/guessed/needs_base_url/rejected/reject_reason/env_key/models；nullable字段保留。R/modelCatalog.ts:706；P/rest-modelCatalog.ts:138-166。 |
| `getCatalogProvider` | 匹配 | GET /catalog/providers/{id} → 单条目录item非{item}，40417/50004。R/modelCatalog.ts:733。 |
| `importCatalogProvider` | 匹配 | POST /providers:import_catalog {catalog_id,api_key?,base_url?,id?} →201 {provider,models_imported}；snake/camel转换对应。R/modelCatalog.ts:511,822；P/rest-modelCatalog.ts:169。后续编辑另见G02。 |
| `importCustomRegistry` | 匹配 | POST /providers:import_registry {url,api_key?} →201 providers.map(vg)/models_imported；credential_env额外字段无害。R/modelCatalog.ts:857；K/app/kosongConfig/modelsDevImportService.ts:190。 |
| `refreshProvider` | 匹配 | POST /providers/{id}:refresh 无body → ES changed/unchanged/failed；id suffix正确。R/modelCatalog.ts:557；R/action-suffix.ts:13。 |
| `refreshAllProviders` | 匹配 | POST /providers:refresh 无body → ES；可选body允许缺省，scope=all。R/modelCatalog.ts:511,919。 |
| `refreshOAuthProviderModels` | 匹配 | POST /providers:refresh_oauth 无body → ES；生产provider_id/provider_name/added/removed对应。R/modelCatalog.ts:914；K/app/auth/authService.ts:326。 |
| `getConfig` | 匹配 | GET /config → jI，providers总为对象，domain保持原样，敏感凭据投影；default/secondary/model/mode/hooks/services/flags等snake映射匹配。R/config.ts:29,112,143,172,192。 |
| `setConfig` | 条件差异 G15 | POST /config → jI；常用mapped字段接受，secondary_model:null正确replace，raw被strict拒绝。R/config.ts:49-87；P/rest-config.ts:53。yolo:false兼容分支不生效，但实际UI用defaultPermissionMode。 |
| `getAuth` | 匹配 | GET /auth → models_ready/providers_count/nullable managed_provider.status；authenticated/expired/revoked/unauthenticated对应。R/auth.ts:15；K/app/authLegacy/authLegacyService.ts:30。 |
| `startOAuthLogin` | 匹配 | POST /oauth/login {}或{region} → pending flow_id/provider/status/verification_uri/...，authenticated分支只需3字段；区域40001旧端回退对应。R/oauth.ts:72；P/rest-oauth.ts:3。 |
| `pollOAuthLogin` | 匹配 | GET /oauth/login → null或flow_id/status/resolved_at?/error_message?；状态枚举一致。R/oauth.ts:98；K/app/auth/oauthProtocol.ts:42。 |
| `cancelOAuthLogin` | 匹配 | DELETE /oauth/login → cancelled/status；无pending可合法false。R/oauth.ts:118；K/app/auth/authService.ts:245。 |
| `logout` | 匹配 | POST /oauth/logout {} → logged_out:true；额外provider忽略，隧道清理失败50001。R/oauth.ts:144；P/rest-oauth.ts:18。 |
| `getUsage` | 匹配 | GET /oauth/usage → raw {kind:ok,quota}或{kind:error,message,status?}，内层camelCase usages/extraUsage由service生产，不误用旧snake mapper。R/oauth.ts:265；packages/oauth/src/managed-usage.ts:61,85,102。 |
| `getUserInfo` | 匹配 | GET /oauth/userinfo → raw kind/userInfo camelCase字段，cloud snake转化存在。R/oauth.ts:285；packages/oauth/src/managed-userinfo.ts:56,90,100。 |
| `getOAuthRegion` | 匹配 | GET /oauth/region → region:mainland-cn/global；错/5s race回退null。R/oauth.ts:305；packages/oauth/src/region.ts:44。 |
| `getClientConfig` | 匹配 | POST /client_configs {name} → config??null；不把background/signal写body；model_switch_confirm parser与调用相符。R/clientConfigs.ts:23-32；services/clientConfigs.ts:51,71。 |

远程设备、OAuth回调、usage/account、registry/catalog等外部系统运行情况本次未调用；上表的匹配仅认证本地wire边界。

## 逐项清单：技能、插件、能力和工作区（25）

| 方法 | 结论 | 请求 → 消费响应；后端证据 |
| --- | --- | --- |
| `listSkills` | 匹配 | GET /sessions/{id}/skills → skills[]供toAppSkills；name/description/path/source/workspace_dir/scopes生产。R/skills.ts:120,410；P/skill.ts:3。 |
| `listSkillsForWorkspace` | 匹配 | GET /workspaces/{id}/skills → 同skill，发现root+additional_dirs。R/skills.ts:153,179。 |
| `toAppSkills` | 辅助 | scopes缺省可见，[]不可见，按identity.clientUiMode筛选；映射workspace_dir；生产不发scopes:null。B158:3577；R/skills.ts:410。 |
| `activateSkill` | 匹配 | POST /sessions/{id}/skills/{name}:activate {path?,metadata?,prompt_id?,args?,attachments?} → activated/skill_name；Bne附件格式相符。R/skills.ts:191,311,325；P/rest-skill.ts:24。与G01不同路径。 |
| `listCapabilities` | 匹配 | GET /capabilities → capabilities[]原样；状态/steps/install/confirmationRequired契约一致。R/capabilities.ts:44；P/rest-capability.ts:3。 |
| `getCapability` | 匹配 | GET /capabilities/{id} → raw capability用于poll install.running/error/confirmation。R/capabilities.ts:65；K/app/capability/capabilityService.ts:98,161。 |
| `installCapability` | 匹配 | POST /capabilities/{id}:install {}或{stopRunningProcesses?} →raw capability；strict、40924进行中、40925不支持对应。R/capabilities.ts:95,141；P/rest-capability.ts:20。 |
| `listPlugins` | 匹配 | GET /plugins → plugins[]；summary id/displayName/enabled/version/state/origin/catalogId/counts等生产。R/plugins.ts:186；K/app/plugin/manager.ts:963。 |
| `getPluginInfo` | 匹配 | GET /plugins/{id}?locale? → info+skills[]+mcpServers[]，localized presentation/runtimeName/transport/key names正确；manifest有意不暴露，UI不读license。R/plugins.ts:207-225；K/app/plugin/manager.ts:989,1011,1074。 |
| `previewPlugin` | 条件差异 G12 | POST /plugins/preview {marketplaceId,expectedVersion?,expectedSha256?,locale?} → capabilities；strict/字段对上，但无digest/non-ZIP目录项不可预览。R/plugins.ts:237；K/app/plugin/pluginService.ts:347。 |
| `listPluginMarketplace` | 条件差异 G14 | GET /plugins/marketplace → entries[]；分类/平台/版本/digest/distribution/install/update等全投影，但locale.displayName在parser丢失。R/plugins.ts:87-172；K/app/plugin/marketplace.ts:424。 |
| `installPlugin` | 匹配 | POST /plugins，string转{source}或marketplaceId/expectedVersion/expectedSha256；180s，真实UI不传locale。返回summary兼容的info超集。R/plugins.ts:267；P/rest-plugin.ts:97；K/app/plugin/pluginService.ts:217。 |
| `setPluginEnabled` | 匹配 | POST /plugins/{id}:enable/disable {} → ok:true，UI只await/refetch。R/plugins.ts:65,69,298,325。 |
| `removePlugin` | 匹配 | POST /plugins/{id}:remove {} → ok:true；40419及40934目录变动对应UI。R/plugins.ts:73,298,339。 |
| `listWorkspaces` | 匹配 | GET /workspaces → items.map(Kg)；id/root/name/kind/additional_dirs/last_opened_at/session_count真实生产。客户端任何错返回[]非成功证据。R/workspaces.ts:80,597；P/workspace.ts:14。 |
| `addWorkspace` | 匹配 | POST /workspaces {root,idempotency_key?,name?,additional_dirs?} → Kg；绝对已有root/name1–100/additional≤64/key1–200约束与UI一致。R/workspaces.ts:100；P/workspace.ts:27。 |
| `deleteWorkspace` | 匹配 | DELETE /workspaces/{id} → deleted:true被忽略。R/workspaces.ts:230。 |
| `updateWorkspace` | 匹配 | PATCH /workspaces/{id} {name?,additional_dirs?} → Kg，空patch允许。R/workspaces.ts:163；P/rest-workspace.ts:26。 |
| `setWorkspacePrimary` | 匹配 | POST /workspaces/{id}/primary {path} → Kg；成员检查和主/附加根交换存在。R/workspaces.ts:343；K/app/workspace/workspaceService.ts:184。 |
| `getWorkspaceProjectConfigDirs` | 匹配 | GET /workspaces/project-config-dirs?root → additional_dirs始终数组。R/workspaces.ts:425；P/rest-workspace.ts:50；workspaceService.ts:233。 |
| `getWorkspaceTrust` | 匹配 | GET /workspaces/{id}/trust → trusted:boolean，background仅transport。R/workspaces.ts:268。 |
| `trustWorkspace` | 匹配 | POST同路径 {} → trusted:true；不放宽后续工具审批。R/workspaces.ts:292。 |
| `browseFs` | 匹配 | GET /fs:browse?path? → path/nullable parent/entries name,path,is_dir；root parent:null合法；错回退空。R/workspaceFs.ts:70；K/app/hostFolderBrowser/hostFolderBrowserService.ts:23。 |
| `getFsHome` | 匹配 | GET /fs:home → home/recent_roots，缺省/错回退。R/workspaceFs.ts:95；hostFolderBrowserService.ts:62。 |
| `mkdirFs` | 匹配 | POST /fs:mkdir {path} → path；本地、非recursive；40001/40409/40411/40919对应UI。R/workspaceFs.ts:152,348,366,400。 |

## 逐项清单：文件、媒体与 Git（24）

| 方法 | 结论 | 请求 → 消费响应；后端证据 |
| --- | --- | --- |
| `listDirectory` | 条件差异 G19 | POST /sessions/{id}/fs:list，path/depth/include_git_status/show_hidden/allow_ignored_globs/allow_external_symlinks → items/children_by_path?/truncated，D5映射正确；include_git_status实际忽略。R/fs.ts:787；K/workspace/workspaceFs/fsService.ts:198,350,1976。 |
| `listWorkspaceDirectory` | 匹配 | POST /workspace/fs:list {workspace,path?,depth?,show_hidden?,allow_ignored_globs?,allow_external_symlinks?} → 同D5列表；不传git_status，strict匹配；注册根目录支持。R/fs.ts:116,405-440。 |
| `readFile` | 条件差异 G07 | POST /sessions/{id}/fs:read {path,offset?,length?,allow_external_symlinks?} → content/encoding/size/truncated/etag/mime/language_id/line_count/is_binary；auto转码默认匹配，additional root绝对路径失败。R/fs.ts:797；K/workspace/workspaceFs/fsService.ts:468。 |
| `searchFiles` | 匹配 | POST /workspace/fs:search {workspace,query,limit?} → items path/name/kind/score/match_positions + truncated；limit1–200。R/fs.ts:123,455-489；K/workspace/workspaceFs/fs.ts:208。 |
| `suggestFiles` | 匹配（策略差异） | POST /workspace/fs:suggest {workspace,query,limit?,show_hidden?} → scored items；stream未发默认false，非NDJSON。R/fs.ts:129,503-539；fs.ts:223。fd/fallback hidden/limit策略不一，见下文。 |
| `suggestFilesAtRoots` | 匹配（策略差异） | POST /fs:suggest {roots,query,limit?,show_hidden?} →scored items；1–32绝对目录，主根相对/其他根绝对，去重。R/fs.ts:136,554-604；fsService.ts:924,977。 |
| `grepFiles` | 匹配（单位差异） | POST /sessions/{id}/fs:grep {pattern,regex?,case_sensitive?} → files[{path,matches[{line,col,text,before,after}]}]/files_scanned/truncated/elapsed_ms。R/fs.ts:857；K/workspace/workspaceFs/fs.ts:244-263。非ASCII col单位有后端差异，见下文。 |
| `getGitStatus` | 条件差异 G03 | POST /fs:git_status {root?,paths?,include_pull_request?} → branch/ahead/behind/entries record/additions/deletions/pullRequest??null；root+非空paths触发绝对拒绝。R/fs.ts:867；fsService.ts:1365-1391。 |
| `getPullRequest` | 匹配 | POST /fs:pull_request {root?} → null或{number,state,url}，open/merged/closed/draft；无root+path错路。R/fs.ts:887；fsService.ts:1404。 |
| `getGitStatusBatch` | 匹配 | POST /fs:git_status:batch {roots,include_pull_request?} → results/errors按root的record，去重、2worker、逐根错误。R/fs.ts:877；fsService.ts:1394,1409-1428。 |
| `getPullRequestBatch` | 匹配 | POST /fs:pull_request:batch {roots} → results:PR/null、errors record，UI区分缺key与null。R/fs.ts:897；K/app/git/git.ts:75-83。 |
| `getFileDiff` | 条件差异 G03 | POST /fs:diff {path,root?} →path/diff/truncated缺省false；带root必走绝对拒绝，unrooted相对path不受该问题影响。R/fs.ts:911；fsService.ts:1431-1447。 |
| `getFileDownloadUrl` | 辅助（差异G07/G08） | 每个/分段encode后拼 /sessions/{id}/fs/{path}:download + symlink query；路由形状对，但bare anchor没Bearer，absolute extra root也失败。R/fs.ts:110,619,644,680；middleware/auth.ts:44。 |
| `downloadSessionFile` | 条件差异 G07 | 同URL，通过带鉴权getBlob；prefixBytes转Range；raw Blob及206契约匹配，additional root路径仍拒绝。R/fs.ts:680-738。 |
| `openFile` | 条件差异 G07 | POST /fs:open {path,line?} →opened:true；正整数line，本地/安全路径限制有意保留；extra root handoff不兼容。R/fs.ts:921；P/rest-fs.ts:3。 |
| `revealFile` | 条件差异 G07 | POST /fs:reveal {path} →revealed:true；同local/containment约束。R/fs.ts:932；P/rest-fs.ts:14。 |
| `openInApp` | 匹配（支持路径内） | POST /fs:open-in {app_id,path,line?} →opened:true被丢弃；finder/cursor/vscode/iterm/terminal枚举对应。R/fs.ts:943；P/rest-fs.ts:24-31；lib/fileLaunch.ts:71。OS未启动。 |
| `uploadFile` | 匹配 | POST /files multipart file+可选name；浏览器生成boundary；id/name/media_type/size映射正确。R/files.ts:57-102；P/rest-file.ts:4；K/app/file/fileService.ts:10。one file/1GiB；上传校验本身非全strict。 |
| `getFileUrl` | 辅助（G08注意） | /files/{encode(fileId)} URL，路由对，不带头；已用Blob的组件不受bare URL问题影响。R/files.ts:117；P/rest-file.ts:7。 |
| `getFileBlob` | 匹配 | 带鉴权 GET /files/{id}，signal/prefix/max选项仅transport →raw Blob，MIME/大小/range/404对应。R/files.ts:131-158,197-212。 |
| `getSessionMediaUrl` | 辅助（G08注意） | /sessions/{session}/media/{fileId}，双ID编码正确，不自行请求。R/sessionMedia.ts:43-53。 |
| `getSessionMediaBlob` | 匹配 | 带鉴权GET同路径 →Blob，先session canonical再staged upload回退、404、MIME/range对应。R/sessionMedia.ts:65-124。 |
| `readHostFileContent` | 条件差异 G13 | 带鉴权GET /fs:content?path=absolute →Blob，客户端按MIME译utf8/base64；10MiB上限，对TOML/UTF16不一致。R/workspaceFs.ts:182,242-342；K/_base/utils/fileMeta.ts:54。 |
| `downloadHostFile` | 匹配 | 带鉴权GET /fs:content?path，prefixBytes为Range →raw Blob不解码；local默认、regular/absolute/realpath/range/cache/error对应。R/workspaceFs.ts:235-345。 |

### 文件域非阻断补充

- fd建议路径固定hidden/最多20，fallback尊重show_hidden/request limit；实际UI请求20。`fsService.ts:826-832`、`internal/fdSuggest.ts:200-208`。后端策略差异，不夸大为响应字段不匹配。
- grep rg返回byte col，fallback用JS UTF-16 index；非ASCII列单位不一。`fsService.ts:1878,1596`。没找到bundle实际grepFiles UI调用，不列为已验证可见错位。
- binary range支持206/content-range；非法range回退200而非416；getBlob自身限制可拒绝超量响应，不把它当无条件成功。错误JSON envelope即使HTTP200也由匹配request_id识别，非误当成功Blob。
- `::` 是 find-my-way 的literal冒号转义，`fs::list`/`auth::begin` 不是URL错误；不可通过全量替换冒号来“修复”。

## Socket 与公共传输逐项核对

| 项目 | 结论 | 证据/影响 |
| --- | --- | --- |
| REST prefix/JSON envelope | 匹配 | f1/Tj B157 用 /api/v1 或显式/api/v2；code/msg/data/request_id，非0抛错，204空body特殊处理。P/envelope.ts:20；start.ts:328；middleware/defineRoute.ts:184。 |
| HTTP Bearer及client headers | 匹配 | Tj.addClientHeaders 对应 auth hook；401/40101 markAuthRequired；不把API登录状态与服务端token混淆。middleware/auth.ts:8,44-83。 |
| WS endpoint/auth | 匹配 | sMe→/api/v1/ws，MMe='kimi-code.bearer.'，start.ts:523-597接收并echo该子协议。transport/ws/bearerProtocol.ts:1-23。 |
| `subscribe` | 部分差异 | flat request_id/session_id/agent_ids，response先于seed/pending已修；恢复异常原因见G10/G11。wsConnectionV1.ts:224-306；sessionEventBroadcaster.ts:235,337。 |
| `unsubscribe` | 匹配 | flat agent_ids?；移除agent、最后agent释放session；generation/listener使迟到page失效。wsConnectionV1.ts:316-350；sessionEventBroadcaster.ts:376-408,500。 |
| `task.watch` | 匹配 | session/agent/task + since_offset/可选tail_bytes，先response+task再初始tail/live；offset为UTF8字节，官方FX也是字节。taskRequests.ts:122-194,233-286；P/ws-task.ts:52。 |
| `task.unwatch` | 匹配 | 同目标flat字段，按task队列顺序dispose，response0。taskRequests.ts:74-80,227。 |
| `task.stop` | 匹配 | stopByUser，返回task全量状态，session40401/task40406；同task串行。taskRequests.ts:83-88,197-224。 |
| `task.background` | 匹配 | detach，running且detached=false返回40941并附task；客户端以非0拒绝，不依赖上游旧40933。taskRequests.ts:90-102。 |
| `ping`/`pong` | 匹配 | server10s、两间隔静默关闭；客户端25s stale/5s检查，pong flat，无handshake要求。wsConnectionV1.ts:184-221；P/ws-control.ts:58。 |
| `response` | 匹配 | request_id匹配、code/msg?/task?；官方订阅成功reset交互后由后续帧重建。transport/ws/v1/protocol.ts:11-17。 |
| `turns` / `turns.failed` | 匹配（故障分类另见G10） | session/agent/event_created_at+turns/has_more或code/msg；异步page失败显式turns.failed+释放监听。sessionEventBroadcaster.ts:402-468,491-511。 |
| `turn.started` / `turn.updated` / `turn.ended` | 匹配 | header、steps/retry merge，持久化投影/真实turn_number，legacy同名信封对conversation订阅抑制。conversationFeed.ts:362-392；sessionEventBroadcaster.ts:1377-1381；RIe B173。 |
| `item.started` / `item.updated` / `item.ended` | 匹配 | item_id/turn_id稳定，set字段合并，最终item替换非append；tool stage及interaction/task/agent refs对应。conversationFeed.ts:395-430；P/conversation.ts。 |
| `item.delta` / `item.removed` / `turns.removed` | 匹配 | text/input_text/output增量，删除按ID；初始page加载buffer再送；retry按stepId去旧内容。conversationFeed.ts:336-359,433-557；conversationFold.ts:652。 |
| `notice` | 匹配 | level/title/detail?/code?直接消费。conversationFeed.ts:581-584；P/conversation.ts noticeSchema。 |
| `interaction` | 匹配 | pending/ended、approval/question请求、tool_call_id、response/outcome/ended_at、q_/opt_翻译与yMe/vMe对应。sessionEventBroadcaster.ts:1190-1224；P/interaction.ts。question响应note另见G16。 |
| `task.list` / `task` | 匹配 | kind shell/subagent/other、status running/ended、outcome等符合Mj；始/终/父工具/child ID/phase/detached对应。taskState.ts:8-42；sessionTaskFeed.ts:35,54-69。 |
| `agent` | 匹配 | status/model/thinking/permission/plan/swarm/tower及compacting布尔，AMe消费对应；压缩开始/完/取消刷新。agentState.ts:18-30；sessionAgentFeed.ts:31-40。 |
| `usage` / `todo` | 匹配 | context_tokens/max_context_tokens?，items title/status；全值覆盖+usage节流。agentState.ts:33-40,56-58；sessionAgentFeed.ts:194-216。 |
| `goal` | 差异 G09 | 普通字段shape匹配但推送缺goalId/budget/terminalReason，替换完整REST对象；扩展状态MS=null。agentState.ts:43-53；P/ws-agent.ts:41-62。 |
| global session/workspace events | 匹配 | xMe需要payload.session/workspace/sessionId/workspace_id/root和busy等，真实producer对应，global发送不依赖订阅。sessionEventBroadcaster.ts:898-979,1321-1340,1365。 |
| global plugin/capability/model-catalog events | 匹配 | type及capability_id/install、changed provider_id/provider_name/added/removed/unchanged/failed对应xMe。sessionEventBroadcaster.ts:982-1044。 |
| global config changed | 字段差异 G20 | config本体匹配jI，但changedFields/changed_fields不一致；当前UI无依赖该列表证据。sessionEventBroadcaster.ts:1018-1028。 |
| API错误重试分类 | 差异 G10/G11 | 恢复错被40401掩盖，wire40940又未在官方terminal集合；需要系统处理而非改客户端。P/error-codes.ts:64,76；DMe.onSubscribeResponse B157。 |

## 本次复核方法与未执行范围

四组独立只读追踪分别覆盖40/35/25/24项，主审覆盖4项公共方法和Socket，合计128且无遗漏。对重点差异额外执行了内存验证，不访问用户配置、不启动业务服务：

1. 真实 prompts 提交handler：技能+prompt_id →40001。
2. reservePromptId：提交后的相同ID →prompt.id_conflict。
3. projectPromptSnapshot：failed →queued。
4. 真实 provider PUT handler+内存配置：省略base/default后变undefined。
5. 真实 fs diff/gitStatus+Windows path替身：root+relative →fs.path_escapes，Git未执行。
6. resolveWithin：注册根绝对路径即使symlink opt-in仍拒绝。
7. 真实 auth hook：直接无头下载 →HTTP401/40101；Bearer可放行。
8. guessMime + 提取的纯jMe：application/toml →非文本。
9. 真实市场parser：locale.displayName丢弃，description保留。
10. strict config/question validator：raw/note拒绝；正常question通过。
11. 真实 readGoalState +纯MS：goal ID/预算丢失；limited状态变null。
12. 真实 subscribe +故障session manager：wire异常被false/40401掩盖；提取的DMe确认40940会进入重试。

这些是实际处理函数/映射验证，不冒充完整网络或外部服务验收。未执行新的一轮全仓测试、真实OAuth/relay/catalog下载/OS launch，也未放宽鉴权、文件边界或插件digest校验。前轮浏览器通过的路径仍以其原有证据范围为准。

**后续实施建议**：先修G01/G02/G03及G04/G05，补官方请求形状的回归；再修G06–G11共享数据和故障语义；最后处理本地插件目录/文本预览及条件字段。修复应全部在后端适配边界完成，不修改官方预构建。
