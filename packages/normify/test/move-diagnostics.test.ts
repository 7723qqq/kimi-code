import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { moveModuleTree } from '#/engine/edit';
import { l1Validate } from '#/engine/frontmatter';
import { writeModuleFile } from '#/engine/store';

import { makeWorkspace, moduleFixture, removeWorkspace, rootFixture } from './helpers';
import type { ProjectFixture } from './helpers';

import { mkdir, writeFile } from 'node:fs/promises';

async function seed(fx: ProjectFixture): Promise<void> {
    await mkdir(join(fx.projectDir, 'modules'), { recursive: true });
    const root = l1Validate(rootFixture(), 'test/root');
    const leaf = l1Validate(moduleFixture(), 'test/leaf');
    if (root.module === null || leaf.module === null) throw new Error('fixture failed L1');
    await writeModuleFile(fx.projectDir, root.module, '');
    await writeModuleFile(fx.projectDir, leaf.module, '');
}

const codes = (r: { errors: { code: string }[] }): string[] => r.errors.map(e => e.code);

describe('moveModuleTree 的加载诊断可解释性', () => {
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

    it('一个解析失败的模块文件不只报 not-found，还报出它为什么没被加载', async () => {
        // 叶子 demo.order 的模块文件是 modules/demo/order.md。把它写成没有
        // frontmatter 的内容，`parseModuleText` 会返回 module: null，该模块就
        // 永远进不了 byId —— 于是 move 只能看到 "not found"，看不到原因。
        await writeFile(join(fx.projectDir, 'modules', 'demo', 'order.md'), 'not a module file\n', 'utf8');

        const res = await moveModuleTree(fx.projectDir, 'demo.order', { newId: 'demo.renamed' });

        expect(res.ok).toBe(false);
        expect(codes(res)).toContain('module/not-found');
        expect(codes(res)).toContain('input/no-frontmatter');
    });

    it('真正不存在的 id 仍然只报一条 not-found，不被别的加载错误污染', async () => {
        const res = await moveModuleTree(fx.projectDir, 'demo.missing', { newId: 'demo.x' });

        expect(res.ok).toBe(false);
        expect(codes(res)).toEqual(['module/not-found']);
    });
});
