import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { batchWrite, patchModule } from '#/engine/edit';
import { l1Validate } from '#/engine/frontmatter';
import { loadAllModules, withProjectLock, writeModuleFile } from '#/engine/store';
import { createMcpServer } from '#/mcp';
import { createToolRegistry } from '#/tools';

import { makeWorkspace, moduleFixture, removeWorkspace, rootFixture } from './helpers';
import type { ProjectFixture } from './helpers';

type ToolResult = { ok?: boolean; error?: { code: string; message: string }; [key: string]: unknown };

async function seed(fx: ProjectFixture): Promise<void> {
    await mkdir(join(fx.projectDir, 'modules'), { recursive: true });
    const root = l1Validate(rootFixture(), 'test/root');
    const leaf = l1Validate(moduleFixture(), 'test/leaf');
    if (root.module === null || leaf.module === null) throw new Error('fixture failed L1');
    await writeModuleFile(fx.projectDir, root.module, '');
    await writeModuleFile(fx.projectDir, leaf.module, '');
}

describe('并发串行化（A6）', () => {
    let fx: ProjectFixture;
    let base: string;

    beforeEach(async () => {
        fx = await makeWorkspace();
        base = join(fx.root, '..');
        await seed(fx);
    });

    afterEach(async () => {
        await removeWorkspace(base);
    });

    it('withProjectLock 串行执行同一项目目录的临界区', async () => {
        const order: string[] = [];
        const slow = (tag: string, ms: number) => withProjectLock(fx.projectDir, async () => {
            order.push(tag + ':start');
            await new Promise(r => setTimeout(r, ms));
            order.push(tag + ':end');
        });
        await Promise.all([slow('a', 30), slow('b', 1)]);
        expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    });

    it('不同项目目录互不阻塞', async () => {
        const other = join(fx.root, 'normify-other');
        const order: string[] = [];
        await Promise.all([
            withProjectLock(fx.projectDir, async () => {
                order.push('p1:start');
                await new Promise(r => setTimeout(r, 20));
                order.push('p1:end');
            }),
            withProjectLock(other, () => {
                order.push('p2:start');
                order.push('p2:end');
                return Promise.resolve();
            }),
        ]);
        // 关键是 p2 的临界区没有等 p1 结束（不同目录不共用一条链）
        expect(order.indexOf('p2:end')).toBeLessThan(order.indexOf('p1:end'));
    });

    it('嵌套同目录调用不自锁（batch → writeModuleFile）', async () => {
        const r = await withProjectLock(fx.projectDir, () =>
            writeModuleFile(fx.projectDir, l1Validate(moduleFixture({ id: 'demo.inner', parent: 'demo', apis: undefined, name: { zh: '内层', en: 'Inner' }, description: { zh: '内层模块', en: 'Inner module' } }), 'test/inner').module!, ''));
        expect(r.file).toBe('modules/demo/inner.md');
    });

    it('两个并发 patch 抢同一个 expect_updated_at：只有一个成功', async () => {
        const current = (await loadAllModules(fx.projectDir)).files.find(f => f.module.id === 'demo.order')!.module.updated_at;
        const [a, b] = await Promise.all([
            patchModule(fx.projectDir, 'demo.order', { description: { zh: '订单域 A', en: 'Domain A' }, expect_updated_at: current }),
            patchModule(fx.projectDir, 'demo.order', { description: { zh: '订单域 B', en: 'Domain B' }, expect_updated_at: current }),
        ]);
        expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
        const loser = a.ok ? b : a;
        expect(loser.errors.map(e => e.code)).toContain('module/conflict');
        const winner = a.ok ? a : b;
        const text = await readFile(join(fx.projectDir, 'modules', 'demo', 'order.md'), 'utf8');
        expect(text).toContain(winner.module?.description.en === 'Domain A' ? 'Domain A' : 'Domain B');
    });

    it('并发 batch + patch 不产生半截模块文件', async () => {
        const item = (id: string) => ({
            frontmatter: moduleFixture({ id, parent: 'demo', apis: undefined, name: { zh: id, en: id }, description: { zh: id, en: id } }),
        });
        await Promise.all([
            batchWrite(fx.projectDir, [item('demo.b1'), item('demo.b2')], 'upsert', {}),
            patchModule(fx.projectDir, 'demo.order', { tags: ['x'] }),
        ]);
        const loaded = await loadAllModules(fx.projectDir);
        expect(loaded.errors).toEqual([]);
        expect(loaded.files.map(f => f.module.id).toSorted()).toEqual(['demo', 'demo.b1', 'demo.b2', 'demo.order']);
    });

    it('MCP tools/call 返回 MCP 结果信封（execute 永不抛）', async () => {
        const server = createMcpServer({
            name: 'normify-test',
            version: '0.0.0',
            tools: [
                {
                    name: 'slow',
                    description: 'test',
                    behavior: 'read',
                    parameters: { type: 'object', properties: {}, additionalProperties: false },
                    execute: async () => {
                        await new Promise(r => setTimeout(r, 5));
                        return { ok: true };
                    },
                },
                {
                    name: 'boom',
                    description: 'test',
                    behavior: 'read',
                    parameters: { type: 'object', properties: {}, additionalProperties: false },
                    execute: () => {
                        throw new Error('boom');
                    },
                },
            ],
        });
        const call = (name: string) => server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }) as Promise<{ content: { text: string }[]; isError?: boolean }>;
        const results = await Promise.all([call('slow'), call('slow')]);
        for (const r of results) expect(JSON.parse(r.content[0]?.text ?? '{}').ok).toBe(true);
        const failed = await call('boom');
        expect(failed.isError).toBe(true);
        expect(failed.content[0]?.text).toContain('boom');
    });

    it('工具层串行 + 锁：并发 module_patch 只有一个成功', async () => {
        const tools = createToolRegistry({ rootDir: fx.root });
        const get = tools.find(t => t.name === 'normify_module_get')!;
        const patch = tools.find(t => t.name === 'normify_module_patch')!;
        const current = (await get.execute({ project: 'demo', id: 'demo.order' })) as ToolResult;
        const updatedAt = (current as { module: { updated_at: string } }).module.updated_at;
        const [a, b] = await Promise.all([
            patch.execute({ project: 'demo', id: 'demo.order', patch: { tags: ['a'], expect_updated_at: updatedAt } }),
            patch.execute({ project: 'demo', id: 'demo.order', patch: { tags: ['b'], expect_updated_at: updatedAt } }),
        ]);
        const oks = [a, b].filter(r => (r as ToolResult).ok === true);
        expect(oks).toHaveLength(1);
        const loser = [a, b].find(r => (r as ToolResult).ok !== true) as ToolResult;
        expect(JSON.stringify(loser.errors ?? loser.error)).toContain('module/conflict');
    });
});
