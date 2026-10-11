# 任务分解与验收

顺序即依赖顺序。每条任务的验收都可以直接运行，且都带**负向验证**（撤掉改动后必须失败）。

---

## T1 共享纯函数模块 `utils/provider-form.ts`

**交付物**：新文件 `apps/kimi-code/src/utils/provider-form.ts`（signature 见 design §2）+ 新测试 `apps/kimi-code/test/utils/provider-form.test.ts`。

**步骤**
1. `PROVIDER_WIRE_TYPES`（6 值）与 `ProviderWireType`。
2. `validateProviderForm(value, { requireApiKey })`：返回 `ProviderFormError | null`，规则同 design §1（id 正则、apiKey 条件必填、baseUrl 仅非空、models ≥1、context 正整数、model 去重）。
3. `normalizeBaseUrlForType`、`defaultModelRow`。
4. `buildAddPatch(value)`：产出 `{ providers: {...}, models: {...} }`；空白 `baseUrl`/`apiKey`/`displayName` 不写键；新行带 `capabilities: ['tool_use','thinking']`、`adaptiveThinking: true`。
5. `planEditWrite(current, value, previousId, { clearApiKey? })`：产出 `{ removeProviderId, patch, collisions, providerIdTaken }`，含改名、删行、默认指针迁移与冲突探测（design §2/§4）。

**验收**
- [ ] `cd apps/kimi-code && bun --bun x vitest run test/utils/provider-form.test.ts` 全绿。
- [ ] 用例覆盖：id 非法（空 / 含 `@` / 含空格前缀 / 含 `/`）→ 对应错误码；**数字开头合法**（与官方 dist-web 及 `modelsDevImport.ts:25` 的 `PROVIDER_ID_PATTERN` 逐字一致，且无长度上限）→ 通过；`maxContextSize` 为 `0`、`-1`、`1.5`、`abc`、`1e3` → `contextSizeInvalid`；`baseUrl='not-a-url'` → 通过。
- [ ] `buildAddPatch` 断言：既有 provider/别名/`thinking` 不出现在 patch 中；空 `apiKey` 不产出 `apiKey` 键。
- [ ] `planEditWrite` 三条改名用例：① 纯改名后新别名存在且旧 id 不再出现；② `defaultModel='old/m'` → `new/m`；③ 删除该默认模型所在行后 `defaultModel` 不出现在 patch（不悬空）。
- [ ] `modelDuplicate`：两行同 model（首尾空白差异视为重复）→ `modelDuplicate`；逐行错误优先（首行 context 非法 + 重复 → 先报 `contextSizeInvalid`）。
- [ ] `planEditWrite` 冲突探测：`collisions` 在他方（`record.provider !== previousId`）已拥有 `${newId}/${model}` 时列出该键、无冲突时为空数组；`providerIdTaken` 在 `newId !== previousId` 且已被占用时为 `true`、否则 `false`。
- [ ] 边界：provider 级 `defaultModel` 非 `${previousId}/` 前缀（如 `other/model`）时原样保留；`current.providers[previousId]` 缺失时不抛异常。

**负向验证**
- [ ] 注释掉 `planEditWrite` 里的 `defaultModel` 迁移分支 → 用例 ② 必须失败。
- [ ] 删除 `maxContextSize` 的正整数校验 → `0`/`abc` 用例必须失败。
- [ ] 把 `collisions` 计算改成恒为空数组 → 冲突用例必须失败。

---

## T2 i18n 键（en + zh 同步）

**交付物**：`apps/kimi-code/src/i18n/locales/en.ts` 与 `zh.ts` 新增 design §6 列出的键（`tui.dialogs.providerForm.*`、`tui.statusMessages.*` 5 个、`cli.commandDescriptions.providerCreate/providerUpdate`、`cli.optionDescriptions.providerCreate*`）。

**验收**
- [ ] `bun run check:locale-keys`、`bun run check:locale-placeholders`、`bun run check:t-coverage` 通过。
- [ ] `bun run check:no-hardcoded-prose` 通过且 `scripts/no-hardcoded-prose-baseline.txt` **无新增行**（`git diff --stat` 断言该文件未改）。
- [ ] `cd apps/kimi-code && bun --bun x vitest run test/i18n/locale-parity.test.ts` 通过。
- [ ] zh 文案不含未翻译英文占位（抽查 `providerForm.error.*` 全部为中文）。

**负向验证**
- [ ] 只往 `zh.ts` 加键、不加 `en.ts` → `check:locale-keys` 必须失败。

---

## T3 TUI 表单组件 `provider-form-dialog.ts`

**交付物**：新文件 `apps/kimi-code/src/tui/components/dialogs/provider-form-dialog.ts` + 测试 `apps/kimi-code/test/tui/components/dialogs/provider-form-dialog.test.ts`（测试写法参照 `custom-registry-import.test.ts`）。

**步骤**：按 design §3 实现（字段顺序、Tab/↑↓ 焦点、`type` 用 ←/→ 循环、models 行列表 + 行编辑子模式、掩码与 `Ctrl-R` 明文、hint 错误行、托管只读、`onDone({kind:'ok'|'cancel', value?})`）。

**验收**
- [ ] `cd apps/kimi-code && bun --bun x vitest run test/tui/components/dialogs/provider-form-dialog.test.ts` 全绿。
- [ ] 渲染断言：输出含 5 个字段标签、不含「默认模型」字段；`type` 循环顺序 = `PROVIDER_WIRE_TYPES`。
- [ ] 交互断言：`A` 后行数 +1；`D` 在只有 1 行时无效（行数仍为 1）；行编辑返回后摘要文本更新；`Tab` 焦点顺序与 design §3 一致。
- [ ] 校验断言：`apiKey` 为空提交 → 仍在表单且出现 `error.apiKeyRequired`；`context` 填 `0` → `error.contextSizeInvalid`。
- [ ] 托管只读断言：传入 `oauth` 非空的 provider → 所有 Input `disabled`，页脚含 `managedReadonly`。

**负向验证**
- [ ] 去掉 `oauth` 判定的禁用分支 → 托管只读用例必须失败。
- [ ] 把「最后一行不可删」的保护去掉 → 行数保护用例必须失败。

---

## T4 TUI 添加接线

**交付物**：`apps/kimi-code/src/tui/commands/provider.ts` 改动 + `test/tui/commands/provider.test.ts` 扩展。

**步骤**
1. `promptProviderAddSource` 增加 `{ value: 'manual', label: t('tui.statusMessages.manualProviderOption') }`，返回类型加 `'manual'`。
2. `handleManualProviderAdd(host)`：挂载表单（add）→ `validateProviderForm` 已在组件内做 → `harness.setConfig(buildAddPatch(value))` → `host.authFlow.refreshConfigAfterLogin()` → 走既有 `TabbedModelSelectorComponent` 选默认模型；取消则 `host.restoreEditor()` 不动配置。
3. 失败：`host.showError(t('tui.statusMessages.providerFormFailed', { error }))`，仅日志记录，不写入。

**验收**
- [ ] `cd apps/kimi-code && bun --bun x vitest run test/tui/commands/provider.test.ts` 全绿。
- [ ] 新增用例：选 `manual` → 提交合法值 → 断言 `harness.setConfig` 恰好调用一次、参数等于 `buildAddPatch(...)`、`refreshConfigAfterLogin` 调用一次。
- [ ] 取消路径：断言 `setConfig` 未被调用、已有 config 未变。
- [ ] 原有两条路径（目录导入 / api.json 导入）用例不变且仍通过（回归保护）。

---

## T5 TUI 编辑

**交付物**：`provider-manager.ts` 增加 `E` 与 `onEdit`；`provider.ts` 新增 `handleProviderEdit`；`test/tui/components/dialogs/provider-manager.test.ts` 与 `test/tui/commands/provider.test.ts` 扩展。

**步骤**
1. `provider-manager.ts`：`E` 触发 `onEdit(row.providerId)`；页脚提示加 `E 编辑`（新键复用 `tui.dialogs.providerManager.headerHint` 的扩展）。
2. `handleProviderEdit(host)`：`harness.getConfig()` → 预填（`providers[id]` + `models` 里 `provider === id` 的别名；`apiKey` 直读；`oauth` 非空 → 表单只读）→ 表单（edit）→ `removeProvider(previousId)` → `setConfig(planEditWrite(...).patch)` → `refreshConfigAfterLogin()` → 重挂列表。
3. 编辑保存后若 `defaultModel` 变化，`setAppState` 同步（沿用 `refreshConfigAfterLogin` 的既有行为）。

**验收**
- [ ] `cd apps/kimi-code && bun --bun x vitest run test/tui/components/dialogs/provider-manager.test.ts test/tui/commands/provider.test.ts` 全绿。
- [ ] 用例：`E` 触发 `onEdit`（含 id 参数）；编辑表单预填字段等于 config 中的值（含 `apiKey`）。
- [ ] 用例：改名编辑 → 断言 `removeProvider('old')` 先于 `setConfig`，且 patch 里是 `new` 前缀别名；config 中无 `old` 残留。
- [ ] 用例：删除一行模型后提交 → patch 中不再包含该别名。
- [ ] 用例：编辑托管 provider → 表单只读、提交按钮不可用、`setConfig` 未被调用。

**负向验证**
- [ ] 把「先 `removeProvider` 再 `setConfig`」改成只 `setConfig` → 改名用例（断言无 `old` 残留）必须失败。

---

## T6 CLI `provider create` / `provider update`

**交付物**：`apps/kimi-code/src/cli/sub/provider.ts` 新增两个子命令与 handler；`apps/kimi-code/src/cli/commands.ts` 注册；`test/cli/provider.test.ts` 扩展。

**验收**
- [ ] `cd apps/kimi-code && bun --bun x vitest run test/cli/provider.test.ts` 全绿。
- [ ] `kimi provider create --id demo --type openai --api-key sk-x --base-url https://api.example.com/v1 --model gpt-4.1 --max-context-size 128000` → 退出码 0，config 新增 `[providers.demo]` 与 `[models."demo/gpt-4.1"]`（用测试内的临时 home 断言）。
- [ ] 缺 `--model` 或缺 `--max-context-size` → 非零退出码 + 明确错误文案，且 config 未写。
- [ ] `kimi provider update demo --new-id demo2 --base-url https://api2.example.com/v1` → 旧键消失、别名前缀迁移、其它字段保留。
- [ ] `--json` 输出中不出现 `--api-key` 的明文（`expect(stdout).not.toContain('sk-x')`）。
- [ ] 复用断言：`create`/`update` 的写盘参数与 T1 的 `buildAddPatch`/`planEditWrite` 输出一致（同一模块导入，可用 spy 断言）。
- [ ] 既有 `provider add/remove/list/catalog` 用例不变且通过。

**负向验证**
- [ ] 让 `create` 用 `z.object` 默认（非 strict）以外的宽松解析直接透传未知 `--type` → 非法 type 用例（`--type nope` 非零退出）必须失败。

---

## T7 删除 `apps/kimi-web` 与全部引用

**交付物**：按 design §7 的表逐项清理；`apps/kimi-web/**` 从 git 移除。

**步骤**
1. `git rm -r apps/kimi-web`（334 文件）；本地 `rm -rf apps/kimi-web/node_modules`（未跟踪，约 600MB）。
2. 改 `package.json`（`:10`、`:40`）。
3. 删 `.github/workflows/ci.yml` 的 `test-kimi-web` job（`:105-125+`）。
4. 改 `DEVELOP.md`（8 处）、`CONTRIBUTING.md:65`、`CONTRIBUTING.zh-CN.md:64`。
5. 改 4 个 `scripts/*.mjs`（locale-keys / t-call-coverage / no-hardcoded-prose / scan-hardcoded-v2）。
6. 改 3 个 `tools/review/src/checks/*.zig`（silent_catch / scripts_wiring / ci_coverage）并删对应 baseline 行（含 `tools/review/check-catalog-versions.mjs` 视实际内容处理）。
7. 先确认 `tools/review` 检查的运行入口（`zig build --help` / `build.zig` 的 step 名），再跑。

**验收**
- [ ] `rg -n 'apps/kimi-web' --glob '!node_modules' --glob '!specs/**' --glob '!reports/**' .` → **0 命中**。
- [ ] `rg -n 'kimi-webbridge' plugins/ packages/node-sdk/` → 与改动前**完全一致**（`git diff --stat` 不含这些文件）。
- [ ] `bun install --frozen-lockfile` 成功（workspaces 少一个排除项后 lockfile 无需变更）。
- [ ] `(cd tools/review && zig build test)` 全绿。
- [ ] `bun run check:locale-keys && bun run check:locale-placeholders && bun run check:t-coverage && bun run check:no-hardcoded-prose && bun run check:locale-keys` 等 9 个 `check:*` 全绿。
- [ ] `bun run lint` 全绿；`bun run typecheck` 全绿（脚本里已无 kimi-web 片段）。
- [ ] `git diff --stat` 中 `tools/review/*-baseline.txt` 只有删除行、无新增行。
- [ ] 推送后 CI 的 `test-kimi-web` job 消失且其余 job 全绿（人工确认一次）。

**负向验证**
- [ ] 把 `apps/kimi-web/src/App.vue  1` 一行塞回 `tools/review/silent-catch-baseline.txt` → 对应检查必须失败（证明基线仍被消费）。
- [ ] 在 `scripts/check-locale-keys.mjs` 里保留 kimi-web 条目 → 该脚本必须因找不到目录而失败（证明条目确实必要）。

---

## T8 文档、changeset 与全套门禁

**交付物**：`docs/zh/configuration/providers.md`（+ 对应英文文件）新增「用 `/provider` 手动添加 / 编辑」「用 `kimi provider create/update`」两小节；changeset（按 `gen-changesets` skill）；最终验证记录。

**验收**
- [ ] 文档两节的示例与 T4/T6 实际行为逐字一致（命令、字段名、默认值）；中文镜像与英文同步。
- [ ] changeset 存在且描述用户可见变化（新增手填添加/编辑、CLI 两个子命令、移除 `apps/kimi-web`），版本号未改动（`git diff --stat` 不含任何 `package.json` 的 `version`）。
- [ ] 全套：`bun run lint`、`bun run typecheck`、9 个 `check:*`、`(cd tools/review && zig build test)`、`bun --bun x vitest run`（根）全绿。
- [ ] 手工验收（真实 TUI）：`/provider` → 添加 → 手动 → 填 `id=demo type=openai api_key=… base_url=… model=gpt-4.1 context=128000` → 保存 → 列表出现 `demo`、`~/.kimi-code/config.toml` 里出现 `[providers.demo]` 与 `[models."demo/gpt-4.1"]`；再次进入 → `E` 编辑改名 `demo2` → 保存后 config 中无 `demo` 残留；删除该 provider 收尾。
- [ ] 负向手工：把 `base_url` 留空保存 → 出现内联错误且不写盘。

---

## 汇总：一次性的最终门禁命令

```bash
cd /home/administrator/kimi/kimi-code
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run check:locale-keys && bun run check:locale-placeholders && bun run check:t-coverage \
  && bun run check:status-surface-i18n && bun run check:no-hardcoded-prose && bun run check:no-comments \
  && bun run check:service-naming && bun run check:nix-workspace && bun run check:catalog-versions
(cd tools/review && zig build test)
cd apps/kimi-code && bun --bun x vitest run test/utils/provider-form.test.ts \
  test/tui/components/dialogs/provider-form-dialog.test.ts \
  test/tui/components/dialogs/provider-manager.test.ts \
  test/tui/commands/provider.test.ts test/cli/provider.test.ts test/i18n/locale-parity.test.ts
rg -n 'apps/kimi-web' --glob '!node_modules' --glob '!specs/**' --glob '!reports/**' .   # 期望 0 命中
```
