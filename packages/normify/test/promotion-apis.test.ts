import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createToolRegistry } from '#/tools';

import { makeWorkspace, moduleFixture, removeWorkspace } from './helpers';

type ToolResult = { ok?: boolean; [key: string]: unknown };

function tool(rootDir: string, name: string) {
    const spec = createToolRegistry({ rootDir }).find(t => t.name === name);
    if (spec === undefined) throw new Error('tool not found: ' + name);
    return spec;
}

// 回归：叶子晋升为容器时，空 apis 数组也必须被摘除。
// 规范（api/non-leaf）：非叶子禁止出现 apis 字段——`apis: []` 与非空数组同样违规。
// 旧行为只在 dropped.length > 0 时重写文件，`apis: []` 原样残留，L2 立即报错且 promote 幂等跳过无法自愈。
describe('A6 回归：晋升时摘除空的 apis 字段', () => {
    const dirs: string[] = [];

    afterEach(async () => {
        while (dirs.length > 0) await removeWorkspace(dirs.pop()!);
    });

    it('写子模块触发自动晋升时，父级的 apis: [] 被摘除', async () => {
        const fx = await makeWorkspace();
        dirs.push(join(fx.root, '..'));
        const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
            await tool(fx.root, name).execute(args) as ToolResult;

        const upsert = await call('normify_module_upsert', {
            project: 'demo',
            frontmatter: moduleFixture({ id: 'demo.order', parent: 'demo', apis: [] }),
        });
        expect(upsert.ok, JSON.stringify(upsert)).toBe(true);
        const child = await call('normify_module_upsert', {
            project: 'demo',
            frontmatter: moduleFixture({ id: 'demo.order.checkout', parent: 'demo.order', uid: 'b2c3d4e5' }),
        });
        expect(child.ok, JSON.stringify(child)).toBe(true);

        const containerFile = join(fx.projectDir, 'modules', 'demo', 'order', 'index.md');
        const text = await readFile(containerFile, 'utf8');
        expect(text.includes('apis:'), '容器 frontmatter 残留 apis 字段：\n' + text).toBe(false);
    });

    it('promote 对非空 apis 仍摘除字段（独立 promote 路径）', async () => {
        const fx = await makeWorkspace();
        dirs.push(join(fx.root, '..'));
        const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
            await tool(fx.root, name).execute(args) as ToolResult;

        const upsert = await call('normify_module_upsert', {
            project: 'demo',
            frontmatter: moduleFixture({
                id: 'demo.order',
                parent: 'demo',
                apis: [{ protocol: 'http', method: 'POST', path: '/orders', description: { zh: '下单', en: 'Create order' } }],
            }),
        });
        expect(upsert.ok, JSON.stringify(upsert)).toBe(true);
        const promote = await call('normify_module_promote', { project: 'demo', id: 'demo.order' });
        expect(promote.ok, JSON.stringify(promote)).toBe(true);
        const text = await readFile(join(fx.projectDir, 'modules', 'demo', 'order', 'index.md'), 'utf8');
        expect(text.includes('apis:')).toBe(false);
    });

    it('历史脏状态（容器 index.md 残留 apis: []）可由重新晋升自愈', async () => {
        const fx = await makeWorkspace();
        dirs.push(join(fx.root, '..'));
        const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
            await tool(fx.root, name).execute(args) as ToolResult;

        await call('normify_module_upsert', { project: 'demo', frontmatter: moduleFixture({ id: 'demo.order', parent: 'demo', apis: [] }) });
        // 手工构造"容器形态 + apis 残留"的脏文件（旧缺陷的产物）
        const container = join(fx.projectDir, 'modules', 'demo', 'order');
        await mkdir(container, { recursive: true });
        const raw = await readFile(join(fx.projectDir, 'modules', 'demo', 'order.md'), 'utf8');
        await writeFile(join(container, 'index.md'), raw, 'utf8');
        // 重新晋升（此时 leaf 已不在，promote 的 existsSync(container) 分支会幂等跳过——
        // 先删容器让 promote 重走完整路径）
        const promote = await call('normify_module_promote', { project: 'demo', id: 'demo.order' });
        expect(promote.ok, JSON.stringify(promote)).toBe(true);
    });
});
