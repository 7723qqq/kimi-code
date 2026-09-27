import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeAllAtomic, writeFileAtomic } from '#/engine/atomic';
import { fingerprintOf, loadAllModules, writeModuleFile } from '#/engine/store';
import { batchWrite } from '#/engine/edit';
import { buildProject } from '#/engine/compile';
import { l1Validate } from '#/engine/frontmatter';

import { makeWorkspace, moduleFixture, removeWorkspace, rootFixture } from './helpers';
import type { ProjectFixture } from './helpers';

describe('原子写（A5）', () => {
    let fx: ProjectFixture;
    let base: string;

    beforeEach(async () => {
        fx = await makeWorkspace();
        base = join(fx.root, '..');
    });

    afterEach(async () => {
        await removeWorkspace(base);
    });

    it('覆盖已有文件不留临时文件，也不产生半截内容', async () => {
        const target = join(fx.root, 'a.txt');
        await writeFile(target, 'old-content', 'utf8');
        await writeFileAtomic(target, 'new-content');
        expect(await readFile(target, 'utf8')).toBe('new-content');
        expect((await readdir(fx.root)).filter(n => n.includes('.tmp'))).toEqual([]);
    });

    it('父目录不存在时自动创建（write 与 rename 都在同目录）', async () => {
        const target = join(fx.root, 'deep', 'nested', 'a.txt');
        await writeFileAtomic(target, 'hello');
        expect(await readFile(target, 'utf8')).toBe('hello');
    });

    it('写失败时清理临时文件（不把 .tmp 留在仓库里）', async () => {
        // 目录当目标：writeFile 必失败，rename 也不会发生
        const target = join(fx.root, 'adir');
        await mkdir(target, { recursive: true });
        await expect(writeFileAtomic(target, 'x')).rejects.toThrow();
        expect((await readdir(fx.root)).filter(n => n.includes('.tmp'))).toEqual([]);
    });

    it('writeAllAtomic：任一 rename 失败则整体回滚，产物集不混新旧', async () => {
        const dir = join(fx.root, 'artifacts');
        await mkdir(dir, { recursive: true });
        const good = join(dir, 'tree.json');
        // 目标是一个已存在的目录：临时文件写得进去，rename 一定失败（跨平台都会失败）
        const blocked = join(dir, 'blocked');
        await writeFile(good, 'OLD-tree', 'utf8');
        await mkdir(blocked, { recursive: true });
        await expect(writeAllAtomic([
            { path: good, data: 'NEW-tree' },
            { path: blocked, data: 'NEW-x' },
        ])).rejects.toThrow();
        expect(await readFile(good, 'utf8')).toBe('OLD-tree');
        expect((await readdir(dir)).filter(n => n.includes('.tmp'))).toEqual([]);
    });

    it('writeAllAtomic：成功时四个产物一起落盘', async () => {
        const dir = join(fx.root, 'artifacts2');
        await writeAllAtomic([
            { path: join(dir, 'a.json'), data: 'A' },
            { path: join(dir, 'b.md'), data: 'B' },
        ]);
        expect(await readFile(join(dir, 'a.json'), 'utf8')).toBe('A');
        expect(await readFile(join(dir, 'b.md'), 'utf8')).toBe('B');
    });

    it('模块文件走原子写：写完仍是可解析的完整模块', async () => {
        await mkdir(join(fx.projectDir, 'modules'), { recursive: true });
        const root = l1Validate(rootFixture(), 'test/root');
        const leaf = l1Validate(moduleFixture(), 'test/leaf');
        if (root.module === null || leaf.module === null) throw new Error('fixture failed L1');
        await writeModuleFile(fx.projectDir, root.module, '');
        await writeModuleFile(fx.projectDir, leaf.module, 'body text');
        const loaded = await loadAllModules(fx.projectDir);
        expect(loaded.errors).toEqual([]);
        expect(loaded.files.map(f => f.module.id)).toEqual(['demo', 'demo.order']);
        const moduleFile = join(fx.projectDir, 'modules', 'demo', 'order.md');
        expect(await readFile(moduleFile, 'utf8')).toContain('uid: a1b2c3d4');
        expect((await readdir(join(fx.projectDir, 'modules', 'demo'))).filter(n => n.includes('.tmp'))).toEqual([]);
    });

    it('build 的四个产物要么全新要么全旧（不含临时文件）', async () => {
        await mkdir(join(fx.root, 'src'), { recursive: true });
        await writeFile(join(fx.root, 'src', 'index.ts'), 'export const root = 1;', 'utf8');
        await writeFile(join(fx.root, 'src', 'order.ts'), 'export const order = 1;', 'utf8');
        await mkdir(join(fx.projectDir, 'modules'), { recursive: true });
        const rootFp = await fingerprintOf(fx.root, [{ path: 'src/index.ts' }]);
        const leafFp = await fingerprintOf(fx.root, [{ path: 'src/order.ts', line: 1, end_line: 20 }]);
        const root = l1Validate(rootFixture({ fingerprint: rootFp.hash }), 'test/root');
        const leaf = l1Validate(moduleFixture({ fingerprint: leafFp.hash }), 'test/leaf');
        if (root.module === null || leaf.module === null) throw new Error('fixture failed L1');
        await writeModuleFile(fx.projectDir, root.module, '');
        await writeModuleFile(fx.projectDir, leaf.module, '');
        const built = await buildProject(fx.projectDir, { repoRoot: fx.root, requireBilingual: true });
        if (!built.ok) throw new Error('build failed: ' + built.errors.map(e => e.code).join(','));
        for (const name of ['tree.json', 'outline.md', 'api-index.json', 'receipt.json'])
            expect(await readFile(join(fx.projectDir, name), 'utf8')).not.toBe('');
        const stray = (await readdir(fx.projectDir)).filter(n => n.includes('.tmp'));
        expect(stray).toEqual([]);
    });

    it('批量写入失败整批回滚：目标文件保持原样', async () => {
        await mkdir(join(fx.projectDir, 'modules'), { recursive: true });
        const root = l1Validate(rootFixture(), 'test/root');
        if (root.module === null) throw new Error('fixture failed L1');
        await writeModuleFile(fx.projectDir, root.module, '');
        const before = await readFile(join(fx.projectDir, 'modules', 'demo', 'index.md'), 'utf8');
        const result = await batchWrite(fx.projectDir, [
            { frontmatter: moduleFixture({ id: 'demo.a', parent: 'demo', name: { zh: '甲', en: 'A' }, description: { zh: '甲', en: 'A' }, apis: undefined, deps: [] }) },
            { frontmatter: moduleFixture({ id: 'demo.bad id', parent: 'demo' }) },
        ], 'upsert', {});
        expect(result.ok).toBe(false);
        expect(await readFile(join(fx.projectDir, 'modules', 'demo', 'index.md'), 'utf8')).toBe(before);
        const loaded = await loadAllModules(fx.projectDir);
        expect(loaded.files.map(f => f.module.id)).toEqual(['demo']);
    });
});
