# Progress

- [x] spec 三件套通过；runner 锁 + 协议；`scripts/lib/{test-suite-lock,cpu-limit}.mjs`
- [x] D1 workspace 租约：修复 + 红→绿 + 真实 `WorkspaceInstanceManager` 集成验证 + bench
- [x] D2 首 token 平均：sum+count 标量化，显示值逐位不变 + 10k 步参考值相等 + 500 条真实事件重放逐字一致 + bench
- [x] D3 `resumeFailures`：64 条上限 + dispose 清表 + dispose 后落定不入表 + 并发 resume 只记一条
- [x] D4 programStatuses：clear 删除 / stop 清表 / 重放只含存活记录 / 根记录保留 / tmux 包装
- [x] 疑点 S3 实测证伪（shutdown 后 tails 归零、仅剩 1 个 listener 且无复用路径）→ 未改
- [x] 疑点 S4 实测复现并修复（子进程 exit 124 → 0，新增子进程回归用例）
- [x] 疑点 S1 / S2 只有机制分析，未做端到端计时 → 未改，如实标注
- [x] grep 卡顿根因（对 Bun 编译的 TS 二进制同样成立）：工具路径缺 `--no-require-git`（非 git 工作区扫 node_modules，15× CPU）→ 已修；ripgrep 线程上限 4（内容扫描 CPU 11.89s → 4.08s，墙钟不变）→ 已修
- [x] 撤销成环：错误信息现在带重复事件类型与队列类型序列（`CycleError.repeatedType`）
- [x] runner：默认 Bun 原生 worker 池、失败文件单独重跑、8 路文件并发 + 单测试串行
- [x] 门禁：agent-core-v2 7955 pass / 0 fail；kimi-code 4892 pass / 0 fail；pi-tui 1146 / 0 fail；根级仅 node-sdk 一条既有失败（stash 证明与本次无关）；typecheck 0；lint 0 error；locale 三件套 + no-comments 全绿
- [x] 提交：main 10 个提交已推送（origin/main = e98d8acb7e）
- [x] Rust 澄清：路径上的 kimi 是 `bun build --compile` 的 TS 二进制，与 Rust 引擎无关；Rust 补丁作废删除
- [x] GitHub `backup/rust-engine-main`、`fix/strict-projection-and-audit-ledger` 已删（API 204）；ruleset `all` 临时去掉 `deletion` 规则后已**还原为原样**（non_fast_forward, code_quality, deletion）；本地远程跟踪引用已 prune
- [ ] 撤销成环的根因：需要现场步骤，或用现在带 `repeated:` 的错误信息再撞一次
