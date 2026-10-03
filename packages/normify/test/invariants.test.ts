import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fingerprintOf } from '#/engine/store';
import { createToolRegistry } from '#/tools';

import { makeWorkspace, moduleFixture, removeWorkspace, rootFixture } from './helpers';
import type { ProjectFixture } from './helpers';

type ToolResult = { ok?: boolean; error?: { code: string; message: string }; [key: string]: unknown };

function tools(rootDir: string) {
    return createToolRegistry({ rootDir });
}

function tool(rootDir: string, name: string) {
    const spec = tools(rootDir).find(t => t.name === name);
    if (spec === undefined) throw new Error('tool not found: ' + name);
    return spec;
}

/** 递归列出目录下的所有文件（用于"没有临时文件残留"这类不变量断言）。 */
async function walkFiles(dir: string, out: string[] = []): Promise<string[]> {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walkFiles(full, out);
        else out.push(full);
    }
    return out;
}

/** 走一遍"正常人的完整闭环"：所有落盘路径都过一遍，最后不留任何 .tmp。 */
describe('A5 不变量：整条写路径不留临时文件', () => {
    let fx: ProjectFixture;
    let base: string;

    beforeEach(async () => {
        fx = await makeWorkspace();
        base = join(fx.root, '..');
    });

    afterEach(async () => {
        await removeWorkspace(base);
    });

    it('project_init → batch → layout → policy → change → refresh → validate → build → render 之后没有 .tmp', async () => {
        const rootFp = await (async () => {
            const { mkdir, writeFile } = await import('node:fs/promises');
            await mkdir(join(fx.root, 'src'), { recursive: true });
            await writeFile(join(fx.root, 'src', 'index.ts'), 'export const root = 1;', 'utf8');
            await writeFile(join(fx.root, 'src', 'order.ts'), 'export const order = 1;', 'utf8');
            return fingerprintOf(fx.root, [{ path: 'src/index.ts' }]);
        })();
        const leafFp = await fingerprintOf(fx.root, [{ path: 'src/order.ts', line: 1, end_line: 20 }]);
        const checkoutFp = await fingerprintOf(fx.root, [{ path: 'src/order.ts', line: 1, end_line: 9 }]);
        const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
            await tool(fx.root, name).execute(args) as ToolResult;

        const steps: [string, Record<string, unknown>][] = [
            ['normify_project_init', { project: 'demo', root: rootFixture({ fingerprint: rootFp.hash }) }],
            ['normify_module_batch', {
                project: 'demo',
                mode: 'upsert',
                items: [
                    { frontmatter: moduleFixture({ fingerprint: leafFp.hash }) },
                    {
                        frontmatter: moduleFixture({
                            id: 'demo.order.checkout',
                            parent: 'demo.order',
                            uid: 'c0ffee01',
                            apis: [],
                            deps: [],
                            fingerprint: checkoutFp.hash,
                            name: { zh: '结算', en: 'Checkout' },
                            description: { zh: '结算子模块', en: 'Checkout sub-module' },
                            source: [{ path: 'src/order.ts', line: 1, end_line: 9 }],
                        }),
                    },
                ],
            }],
            ['normify_layout_upsert', { project: 'demo', id: 'demo.order', order: ['demo.order.checkout'] }],
            ['normify_policy_upsert', { project: 'demo', rules: [{ id: 'core-acyclic', type: 'acyclic', severity: 'error' }] }],
            ['normify_change_open', {
                project: 'demo',
                title: { zh: '订单域建树', en: 'Order domain tree' },
                intent: { zh: '建一棵订单子树', en: 'Build the order subtree' },
                modules: { create: ['demo.order'] },
                acceptance: ['validate 0 error'],
            }],
            ['normify_module_promote', { project: 'demo', id: 'demo.order.checkout' }],
            ['normify_validate', { project: 'demo', repoRoot: fx.root }],
            ['normify_build', { project: 'demo', repoRoot: fx.root }],
            ['normify_render', { project: 'demo' }],
        ];
        for (const [name, args] of steps) {
            const result = await call(name, args);
            // 闭环里每一步都应成功；失败就把诊断带出来，避免"断言被跳过"
            expect(result.ok, name + ': ' + JSON.stringify(result.errors ?? result.error)).toBe(true);
        }

        const files = await walkFiles(fx.projectDir);
        expect(files.length).toBeGreaterThan(5);
        expect(files.filter(f => f.includes('.tmp'))).toEqual([]);
        // 产物确实都在
        for (const artifact of ['tree.json', 'outline.md', 'api-index.json', 'receipt.json', 'policy.yml', 'normify.html'])
            expect((await stat(join(fx.projectDir, artifact))).isFile(), artifact).toBe(true);
    }, 30_000);
});

describe('A4 不变量：schema 声明的参数永远不会被自己的校验器拒掉', () => {
    let fx: ProjectFixture;
    let base: string;

    beforeEach(async () => {
        fx = await makeWorkspace();
        base = join(fx.root, '..');
    });

    afterEach(async () => {
        await removeWorkspace(base);
    });

    it('按 schema 造出合法实参，31 个工具全部通过校验层', async () => {
        const { validateArgs } = await import('#/engine/args');
        const dummy = (schema: { type?: string; enum?: unknown[]; properties?: Record<string, { type?: string }> } | undefined): unknown => {
            const type = schema?.type;
            if (type === 'boolean') return true;
            if (type === 'number' || type === 'integer') return 1;
            if (type === 'array') return [];
            if (type === 'object') {
                const props = schema?.properties;
                if (props === undefined) return {};
                const out: Record<string, unknown> = {};
                for (const [key, child] of Object.entries(props)) out[key] = dummy(child);
                return out;
            }
            return 'demo';
        };
        for (const spec of tools(fx.root)) {
            const properties = spec.parameters?.properties ?? {};
            const args: Record<string, unknown> = {};
            for (const [key, schema] of Object.entries(properties)) {
                // parent 显式 null 是根模块语义；project/dir 同理允许缺省
                if (key === 'parent') { args.parent = null; continue; }
                args[key] = dummy(schema as { type?: string; properties?: Record<string, { type?: string }> });
            }
            const checked = validateArgs(spec.parameters, args);
            expect(checked.ok, spec.name + ' → ' + (checked.ok ? '' : checked.message)).toBe(true);
        }
    });
});

describe('A4 不变量：布尔位都吃字符串写法', () => {
    let fx: ProjectFixture;
    let base: string;

    beforeEach(async () => {
        fx = await makeWorkspace();
        base = join(fx.root, '..');
    });

    afterEach(async () => {
        await removeWorkspace(base);
    });

    it.each([
        ['normify_module_upsert', 'dry_run'],
        ['normify_module_patch', 'dry_run'],
        ['normify_module_batch', 'dry_run'],
        ['normify_module_move', 'dry_run'],
        ['normify_module_refresh', 'dry_run'],
        ['normify_policy_upsert', 'dry_run'],
        ['normify_module_list', 'direct_only'],
        ['normify_module_refresh', 'activate'],
    ])('%s 的 %s 接受 "true"/"false" 字符串', async (name, flag) => {
        const { validateArgs } = await import('#/engine/args');
        const spec = tools(fx.root).find(t => t.name === name)!;
        for (const raw of ['true', 'false', '1', '0', true, false]) {
            const checked = validateArgs(spec.parameters, { [flag]: raw });
            expect(checked.ok, name + '.' + flag + '=' + JSON.stringify(raw)).toBe(true);
            expect((checked.ok ? checked.args : {})[flag]).toBe(typeof raw === 'string' ? raw === 'true' || raw === '1' : raw);
        }
    });
});

/** 指纹必须与检出时的行尾无关。 */
describe('A6 不变量：指纹与检出时的行尾无关', () => {
    let fx: ProjectFixture;
    let base: string;

    beforeEach(async () => {
        fx = await makeWorkspace();
        base = join(fx.root, '..');
    });

    afterEach(async () => {
        await removeWorkspace(base);
    });

    it('同一文件在 LF 与 CRLF 两种行尾下得到同一个指纹', async () => {
        // `.gitattributes` 保证工作树是 LF，但 `git add` 只归一化它入库的内容：已经带 CRLF
        // 的检出在文件被重写前一直保留那些字节，而 `git status` 仍报干净。指纹若依赖它们，
        // 在 CRLF 检出上刷新出来的值就永远匹配不了干净的 CI 检出（kimi-inspect 模块就是这样
        // 本地绿、CI 红）。latin1 对 0x00–0xFF 是恒等映射，所以只有含 CRLF 的内容会移动。
        const { mkdir, writeFile } = await import('node:fs/promises');
        await mkdir(join(fx.root, 'src'), { recursive: true });
        const lf = 'export const order = 1;\nexport const other = 2;\n';

        await writeFile(join(fx.root, 'src', 'order.ts'), lf, 'utf8');
        const fromLf = await fingerprintOf(fx.root, [{ path: 'src/order.ts' }]);

        await writeFile(join(fx.root, 'src', 'order.ts'), lf.replaceAll('\n', '\r\n'), 'utf8');
        const fromCrlf = await fingerprintOf(fx.root, [{ path: 'src/order.ts' }]);

        expect(fromLf.hash).not.toBeNull();
        expect(fromCrlf.hash).toBe(fromLf.hash);
    });
});
