import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LocalizedText } from '#/engine/types';

export interface ProjectFixture {
    /** 仓库根（结构数据目录的父目录）。 */
    root: string;
    /** 仓库根之外的一个独立目录，用来验证越界写入/读取确实没发生。 */
    outside: string;
    /** 结构数据目录：<root>/normify-demo。 */
    projectDir: string;
}

/** 每个测试一个独立临时根目录；`outside` 与 `root` 同级，逃逸路径一定会打到它。 */
export async function makeWorkspace(): Promise<ProjectFixture> {
    const base = await mkdtemp(join(tmpdir(), 'normify-test-'));
    const root = join(base, 'workspace');
    const outside = join(base, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    return { root, outside, projectDir: join(root, 'normify-demo') };
}

export async function removeWorkspace(base: string): Promise<void> {
    await rm(base, { recursive: true, force: true });
}

export function l10n(zh: string, en: string): LocalizedText {
    return { zh, en };
}

/** 造一棵最小可校验的树：demo（根容器）+ demo.order（叶子，带一条 API 与一个 source）。 */
export function moduleFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        uid: 'a1b2c3d4',
        id: 'demo.order',
        parent: 'demo',
        name: l10n('订单', 'Order'),
        description: l10n('订单域', 'Order domain'),
        source: [{ path: 'src/order.ts', line: 1, end_line: 20 }],
        revision: '0'.repeat(40),
        updated_at: '2026-01-01T00:00:00.000Z',
        fingerprint: 'f'.repeat(64),
        state: 'active',
        apis: [{ protocol: 'http', method: 'POST', path: '/orders', description: l10n('下单', 'Create order') }],
        deps: [],
        ...overrides,
    };
}

export function rootFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        uid: 'ffff0000',
        id: 'demo',
        parent: null,
        name: l10n('演示', 'Demo'),
        description: l10n('演示项目', 'Demo project'),
        source: [{ path: 'src/index.ts' }],
        revision: '0'.repeat(40),
        updated_at: '2026-01-01T00:00:00.000Z',
        fingerprint: '0'.repeat(64),
        state: 'active',
        ...overrides,
    };
}
