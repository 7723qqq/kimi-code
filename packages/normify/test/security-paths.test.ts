import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveOutputPath } from '#/engine/paths';
import { renderProject } from '#/engine/render';
import { fingerprintOf, resolveProject, writeModuleFile } from '#/engine/store';
import { checkSourceEntry, l1Validate } from '#/engine/frontmatter';
import { createToolRegistry } from '#/tools';
import type { Diagnostic } from '#/engine/types';

import { makeWorkspace, moduleFixture, removeWorkspace, rootFixture } from './helpers';
import type { ProjectFixture } from './helpers';

type ToolResult = { ok?: boolean; errors?: string[]; error?: { code: string; message: string }; [key: string]: unknown };

function tool(name: string, rootDir: string) {
    const spec = createToolRegistry({ rootDir }).find(t => t.name === name);
    if (spec === undefined) throw new Error('tool not found: ' + name);
    return spec;
}

async function seedProject(fx: ProjectFixture): Promise<void> {
    await mkdir(join(fx.projectDir, 'modules'), { recursive: true });
    const root = l1Validate(rootFixture(), 'test/root');
    const leaf = l1Validate(moduleFixture(), 'test/leaf');
    if (root.module === null || leaf.module === null) throw new Error('fixture failed L1');
    await writeModuleFile(fx.projectDir, root.module, '');
    await writeModuleFile(fx.projectDir, leaf.module, '');
    await writeFile(join(fx.projectDir, 'tree.json'), JSON.stringify({ project: { name: 'normify-demo', compiled_at: '2026-01-01T00:00:00.000Z', stats: {} }, modules: {} }), 'utf8');
}

describe('路径围栏（A1 render out / A2 fingerprint source / A3 project dir）', () => {
    let fx: ProjectFixture;
    let base: string;

    beforeEach(async () => {
        fx = await makeWorkspace();
        base = join(fx.root, '..');
        await seedProject(fx);
    });

    afterEach(async () => {
        await removeWorkspace(base);
        delete process.env.NORMIFY_ALLOW_PROJECT_OUTSIDE_ROOT;
    });

    describe('A1: normify_render 的 out 不得越出结构数据目录', () => {
        const rejects = [
            ['相对逃逸', '../../../../pwned.html'],
            ['单级逃逸', '../pwned.html'],
            ['嵌套逃逸', 'reports/../../pwned.html'],
            ['POSIX 绝对路径', '/tmp/pwned.html'],
            ['Windows 盘符', 'C:/Windows/pwned.html'],
            ['UNC', '//server/share/pwned.html'],
            ['反斜杠分隔', '..\\pwned.html'],
        ] as const;

        it.each(rejects)('%s 被拒绝且不产生文件', async (_label, out) => {
            const result = await renderProject(fx.projectDir, { out });
            expect(result.ok).toBe(false);
            expect(result.errors[0]?.code).toBe('render/out-escape');
            expect(result.htmlPath).toBeNull();
            await expect(readFile(join(fx.outside, 'pwned.html'), 'utf8')).rejects.toThrow();
        });

        it('默认输出与相对子目录输出正常', async () => {
            const ok = await renderProject(fx.projectDir, {});
            expect(ok.ok).toBe(true);
            expect(ok.htmlPath).toBe(join(fx.projectDir, 'normify.html'));

            const nested = await renderProject(fx.projectDir, { out: 'reports/arch.html' });
            expect(nested.ok).toBe(true);
            expect(nested.htmlPath).toBe(join(fx.projectDir, 'reports', 'arch.html'));
        });

        it('经 MCP 工具同样被拒（args 来自 tools/call）', async () => {
            const r = (await tool('normify_render', fx.root).execute({ project: 'demo', out: '../../../etc/pwned.html' })) as ToolResult;
            expect(r.ok).toBe(false);
            expect(JSON.stringify(r.errors ?? r.error)).toContain('render/out-escape');
        });
    });

    describe('A2: normify_fingerprint 的 source 必须是仓库内相对路径', () => {
        const rejects = [
            ['上跳', '../../secret.txt'],
            ['内嵌上跳', 'src/../../secret.txt'],
            ['POSIX 绝对', '/etc/passwd'],
            ['Windows 盘符', 'C:/Windows/win.ini'],
            ['反斜杠', 'src\\secret.txt'],
            ['空段', 'src//secret.txt'],
        ] as const;

        it.each(rejects)('%s 被 checkSourceEntry 拒绝', async (_label, path) => {
            const r = (await tool('normify_fingerprint', fx.root).execute({ repoRoot: fx.outside, source: [{ path }] })) as ToolResult;
            expect(r.ok).toBe(false);
            expect((r.errors ?? []).join('\n')).toContain('structure/source-path-invalid');
            expect(r.fingerprint).toBeUndefined();
        });

        it('正常相对路径仍能算出指纹', async () => {
            await writeFile(join(fx.outside, 'a.ts'), 'export const a = 1;', 'utf8');
            const r = (await tool('normify_fingerprint', fx.root).execute({ repoRoot: fx.outside, source: [{ path: 'a.ts' }] })) as ToolResult;
            expect(r.ok).toBe(true);
            expect(String(r.fingerprint)).toMatch(/^[0-9a-f]{64}$/);
        });

        it('非对象条目与非字符串 path 在 schema 层就被拒（非 L1 诊断形状）', async () => {
            const r = (await tool('normify_fingerprint', fx.root).execute({ repoRoot: fx.outside, source: ['a.ts', { path: 42 }] })) as ToolResult;
            expect(r.ok).toBe(false);
            expect(r.error?.code).toBe('args/invalid');
            expect(r.fingerprint).toBeUndefined();
        });

        it('checkSourceEntry 本身也拒非对象条目（单一校验器，L1 与 fingerprint 共用）', () => {
            const errors: Diagnostic[] = [];
            expect(checkSourceEntry('a.ts', 'test/source/0', errors)).toBe(false);
            expect(errors[0]?.code).toBe('structure/source-entry-shape');
        });

        it('符号链接指向仓库外时按 missing 处理（读预言机被切断）', async () => {
            const secret = join(fx.outside, 'secret.txt');
            await writeFile(secret, 'top-secret', 'utf8');
            const repo = join(fx.root, 'repo');
            await mkdir(repo, { recursive: true });
            const { symlink } = await import('node:fs/promises');
            await symlink(secret, join(repo, 'link.txt'));
            const fp = await fingerprintOf(repo, [{ path: 'link.txt' }]);
            expect(fp.hash).toBeNull();
            expect(fp.missing).toEqual(['link.txt']);
        });
    });

    describe('A3: 结构数据目录不得指向声明 root 之外', () => {
        it('dir 相对上跳被拒', async () => {
            await expect(resolveProject(fx.root, { dir: '../outside/normify-evil' }, { create: true }))
                .rejects.toMatchObject({ code: 'project/out-of-root' });
            await expect(readFile(join(fx.outside, 'normify-evil', 'policy.yml'), 'utf8')).rejects.toThrow();
        });

        it('dir 绝对路径（落在 root 外）被拒', async () => {
            await expect(resolveProject(fx.root, { dir: join(fx.outside, 'normify-evil') }, { create: true }))
                .rejects.toMatchObject({ code: 'project/out-of-root' });
        });

        it('project 含路径特征时同样被围栏拦下', async () => {
            await expect(resolveProject(fx.root, { project: '../outside/normify-evil' }, { create: true }))
                .rejects.toMatchObject({ code: 'project/out-of-root' });
        });

        it('root 内的相对 dir 正常', async () => {
            const proj = await resolveProject(fx.root, { dir: 'normify-demo' });
            expect(proj.slug).toBe('demo');
            expect(proj.dir).toBe(fx.projectDir);
        });

        it('显式开关才允许跨根（opt-in，不是目录名前缀兜底）', async () => {
            process.env.NORMIFY_ALLOW_PROJECT_OUTSIDE_ROOT = '1';
            const proj = await resolveProject(fx.root, { dir: join(fx.outside, 'normify-evil') }, { create: true });
            expect(proj.dir).toBe(join(fx.outside, 'normify-evil'));
        });
    });
});
