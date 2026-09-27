import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * 路径围栏（path containment）：所有"外部可控的路径"在落盘/读盘前都要过一次这里。
 * 词法比较挡不住符号链接，所以两侧都取 realpath 再比 `relative`。
 */

/** 解析 realpath；目标不存在时退化为"最深的已存在祖先"的 realpath + 余下段（创建场景）。 */
export function realpathDeepest(target: string): string {
    let current = resolve(target);
    const tail: string[] = [];
    for (;;) {
        try {
            return resolve(realpathSync(current), ...tail);
        }
        catch {
            const parent = dirname(current);
            if (parent === current) return resolve(target);
            tail.unshift(basename(current));
            current = parent;
        }
    }
}

/** `rel` 是否越界：`..` 前缀、绝对路径、或空（等于 root 自身）都算越界。 */
export function escapesRoot(rel: string): boolean {
    return rel === '' || rel === '..' || rel.startsWith('..' + sep) || rel.startsWith('../') || isAbsolute(rel);
}

/** target 是否严格位于 root 之内（两侧 realpath 后比较；root 自身返回 false）。 */
export function isWithinRoot(root: string, target: string): boolean {
    return !escapesRoot(relative(realpathDeepest(root), realpathDeepest(target)));
}

export type OutputPath = { ok: true; path: string } | { ok: false; reason: string };

/**
 * 校验 render 的 `out`：只允许结构数据目录下的正斜杠相对文件名。
 * 绝对路径、`..` 段、反斜杠一律拒绝（写越界/覆盖任意文件都从这条进来）。
 */
export function resolveOutputPath(projectDir: string, out: string | undefined): OutputPath {
    const raw = (out ?? '').trim();
    const rel = raw === '' ? 'normify.html' : raw;
    if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith('/'))
        return { ok: false, reason: '输出路径必须是结构数据目录下的相对文件名，不能是绝对路径：' + rel };
    if (rel.includes('\\'))
        return { ok: false, reason: '输出路径只允许正斜杠：' + rel };
    if (rel.split('/').some(seg => seg === '..'))
        return { ok: false, reason: '输出路径不允许包含 .. 段：' + rel };
    const target = resolve(projectDir, rel);
    if (escapesRoot(relative(resolve(projectDir), target)))
        return { ok: false, reason: '输出路径越出结构数据目录：' + rel };
    return { ok: true, path: target };
}
