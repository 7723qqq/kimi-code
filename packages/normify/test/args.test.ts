import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { LIMITS, coerceBoolean, validateArgs } from '#/engine/args';
import { createToolRegistry } from '#/tools';
import { loadAllModules } from '#/engine/store';

import { makeWorkspace, moduleFixture, removeWorkspace, rootFixture } from './helpers';
import type { ProjectFixture } from './helpers';

type ToolResult = { ok?: boolean; error?: { code: string; message: string }; file?: string; dry_run?: boolean; errors?: string[]; [key: string]: unknown };

function tool(name: string, rootDir: string) {
    const spec = createToolRegistry({ rootDir }).find(t => t.name === name);
    if (spec === undefined) throw new Error('tool not found: ' + name);
    return spec;
}

describe('MCP 入参校验（A4）', () => {
    let fx: ProjectFixture;
    let base: string;

    beforeEach(async () => {
        fx = await makeWorkspace();
        base = join(fx.root, '..');
    });

    afterEach(async () => {
        await removeWorkspace(base);
    });

    describe('dry_run 的字符串/布尔混淆', () => {
        it.each([
            ['"true"', 'true'],
            ['"false"', 'false'],
            ['"1"', '1'],
            ['"0"', '0'],
        ])('coerceBoolean(%s) → %s', (input, expected) => {
            expect(coerceBoolean(JSON.parse(input))).toEqual({ ok: true, value: expected === 'true' || expected === '1' });
        });

        it('非布尔、非布尔字符串被拒', () => {
            expect(coerceBoolean('yes').ok).toBe(false);
            expect(coerceBoolean(1).ok).toBe(false);
            expect(coerceBoolean(null).ok).toBe(false);
        });

        it('dry_run:"true" 真的走 dry run（旧实现会静默真实写入）', async () => {
            const r = (await tool('normify_module_upsert', fx.root).execute({
                project: 'demo',
                dry_run: 'true',
                frontmatter: rootFixture(),
            })) as ToolResult;
            expect(r.ok).toBe(true);
            expect(r.dry_run).toBe(true);
            // 结构数据目录建了，但模块文件没落盘
            const loaded = await loadAllModules(fx.projectDir);
            expect(loaded.files).toEqual([]);
        });

        it('dry_run:"false" 按调用方意图真实写入', async () => {
            const r = (await tool('normify_module_upsert', fx.root).execute({
                project: 'demo',
                dry_run: 'false',
                frontmatter: rootFixture(),
            })) as ToolResult;
            expect(r.ok).toBe(true);
            const loaded = await loadAllModules(fx.projectDir);
            expect(loaded.files.map(f => f.module.id)).toEqual(['demo']);
        });

        it('dry_run:"1" 同样被当作 true', async () => {
            const r = (await tool('normify_module_upsert', fx.root).execute({
                project: 'demo',
                dry_run: '1',
                frontmatter: rootFixture(),
            })) as ToolResult;
            expect(r.dry_run).toBe(true);
        });
    });

    describe('类型与未知键', () => {
        it('类型不符按 schema 拒（args/invalid）', async () => {
            const r = (await tool('normify_module_get', fx.root).execute({ project: 'demo', id: 42 })) as ToolResult;
            expect(r.ok).toBe(false);
            expect(r.error?.code).toBe('args/invalid');
            expect(r.error?.message).toContain('id');
        });

        it('未知参数被拒', async () => {
            const r = (await tool('normify_module_get', fx.root).execute({ project: 'demo', id: 'demo', evil: 1 })) as ToolResult;
            expect(r.ok).toBe(false);
            expect(r.error?.code).toBe('args/invalid');
            expect(r.error?.message).toContain('evil');
        });

        it('缺必填仍是 args/missing', async () => {
            const r = (await tool('normify_module_get', fx.root).execute({ project: 'demo' })) as ToolResult;
            expect(r.error?.code).toBe('args/missing');
        });

        it('parent 显式 null 仍被接受（根模块语义）', async () => {
            const r = (await tool('normify_module_upsert', fx.root).execute({
                project: 'demo',
                frontmatter: rootFixture(),
            })) as ToolResult;
            expect(r.ok).toBe(true);
        });

        it('嵌套 frontmatter 的未知字段被拒', async () => {
            const r = (await tool('normify_module_upsert', fx.root).execute({
                project: 'demo',
                frontmatter: rootFixture({ nope: 1 }),
            })) as ToolResult;
            expect(r.ok).toBe(false);
            expect(r.error?.code).toBe('args/invalid');
        });
    });

    describe('体量上限', () => {
        it('items 超过上限被拒', async () => {
            const items = Array.from({ length: LIMITS.arrayItems + 1 }, () => ({ frontmatter: moduleFixture() }));
            const r = (await tool('normify_module_batch', fx.root).execute({ project: 'demo', items })) as ToolResult;
            expect(r.ok).toBe(false);
            expect(r.error?.code).toBe('args/invalid');
            expect(r.error?.message).toContain('items');
        });

        it('source 超过上限被拒', async () => {
            const source = Array.from({ length: LIMITS.arrayItems + 1 }, (_, i) => ({ path: 'src/f' + i + '.ts' }));
            const r = (await tool('normify_fingerprint', fx.root).execute({ repoRoot: fx.root, source })) as ToolResult;
            expect(r.ok).toBe(false);
            expect(r.error?.message).toContain('source');
        });

        it('body 超过上限被拒', async () => {
            const r = (await tool('normify_module_upsert', fx.root).execute({
                project: 'demo',
                frontmatter: rootFixture(),
                body: 'x'.repeat(LIMITS.textLength + 1),
            })) as ToolResult;
            expect(r.ok).toBe(false);
            expect(r.error?.message).toContain('body');
        });

        it('整个 arguments 超过上限被拒', () => {
            const huge = 'y'.repeat(LIMITS.totalBytes);
            const checked = validateArgs({ type: 'object', properties: { task: { type: 'string' } }, additionalProperties: false }, { task: huge });
            expect(checked.ok).toBe(false);
        });
    });

    describe('全注册表冒烟：入参校验不许把任何工具变成 throw', () => {
        it('30 个工具空实参都返回结构化结果', async () => {
            const tools = createToolRegistry({ rootDir: fx.root });
            // 实际注册 31 个（package.json 描述里写的是 30，见交付报告里的事实核对）
            expect(tools.length).toBe(31);
            for (const spec of tools) {
                const result = await spec.execute({}) as { ok?: boolean; error?: { code: string } };
                expect(typeof result, spec.name).toBe('object');
                // 空实参只允许两种结果：真的不需要参数，或给出既有错误码
                if (result.ok !== true)
                    expect(typeof result.error?.code, spec.name).toBe('string');
            }
        });
    });
});
