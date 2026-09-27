import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖。
 * `writeFile` 直写在崩溃/写满磁盘时会留下截断文件——模块文件一旦截断，下次加载
 * parseModuleText 失败会让该模块直接从加载集里消失（比写坏更危险：静默丢模块）。
 */

export interface AtomicWrite {
    path: string;
    data: string | Buffer;
}

function tempFor(path: string): string {
    return join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
}

/** 单文件原子写：临时文件与目标同目录（跨卷 rename 会失败），失败时清理临时文件。 */
export async function writeFileAtomic(path: string, data: string | Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = tempFor(path);
    try {
        await writeFile(tmp, data);
        await rename(tmp, path);
    }
    catch (error) {
        await rm(tmp, { force: true }).catch(() => {});
        throw error;
    }
}

/**
 * 多产物原子写（compile 的 tree.json / outline.md / api-index.json / receipt.json）：
 * 先把全部临时文件写完，再逐个 rename；任一步失败回滚已 rename 的目标并清理临时文件，
 * 不会留下"新旧混合"的产物集。
 */
export async function writeAllAtomic(writes: AtomicWrite[]): Promise<void> {
    const staged: { tmp: string; path: string }[] = [];
    const done: string[] = [];
    const previous = new Map<string, Buffer | null>();
    try {
        for (const w of writes) {
            await mkdir(dirname(w.path), { recursive: true });
            const tmp = tempFor(w.path);
            await writeFile(tmp, w.data);
            staged.push({ tmp, path: w.path });
        }
        for (const { tmp, path } of staged) {
            if (!previous.has(path)) {
                previous.set(path, await readFile(path).catch(() => null));
            }
            await rename(tmp, path);
            done.push(path);
        }
    }
    catch (error) {
        for (const path of done) {
            const before = previous.get(path) ?? null;
            if (before === null) await rm(path, { force: true });
            else await writeFileAtomic(path, before);
        }
        await Promise.all(staged.map(s => rm(s.tmp, { force: true }).catch(() => {})));
        throw error;
    }
}
