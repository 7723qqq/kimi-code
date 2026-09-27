import { describe, expect, it } from 'vitest';

import { checkSourceEntry, l1Validate, parseModuleText } from '#/engine/frontmatter';
import type { Diagnostic } from '#/engine/types';

import { moduleFixture, rootFixture } from './helpers';

function codesOf(frontmatter: unknown): string[] {
    return l1Validate(frontmatter, 'test/l1').errors.map(e => e.code);
}

describe('L1 拒绝矩阵', () => {
    it('合法模块零诊断', () => {
        expect(codesOf(moduleFixture())).toEqual([]);
        expect(codesOf(rootFixture())).toEqual([]);
    });

    describe('结构层', () => {
        it.each([
            ['source 里的 ..', moduleFixture({ source: [{ path: '../secret.ts' }] }), 'structure/source-path-invalid'],
            ['source 里的内嵌 ..', moduleFixture({ source: [{ path: 'src/../../secret.ts' }] }), 'structure/source-path-invalid'],
            ['source 绝对路径', moduleFixture({ source: [{ path: '/etc/passwd' }] }), 'structure/source-path-invalid'],
            ['source 盘符路径', moduleFixture({ source: [{ path: 'C:/Windows/win.ini' }] }), 'structure/source-path-invalid'],
            ['source 反斜杠', moduleFixture({ source: [{ path: 'src\\order.ts' }] }), 'structure/source-path-invalid'],
            ['source 空段', moduleFixture({ source: [{ path: 'src//order.ts' }] }), 'structure/source-path-invalid'],
            ['source 非对象', moduleFixture({ source: ['src/order.ts'] }), 'structure/source-entry-shape'],
            ['source.path 非字符串', moduleFixture({ source: [{ path: 42 }] }), 'structure/source-path-invalid'],
            ['source 未知字段', moduleFixture({ source: [{ path: 'src/order.ts', bogus: 1 }] }), 'structure/unknown-field'],
            ['source 行号非正整数', moduleFixture({ source: [{ path: 'src/order.ts', line: 0 }] }), 'structure/source-line-invalid'],
            ['source 行号区间倒挂', moduleFixture({ source: [{ path: 'src/order.ts', line: 9, end_line: 2 }] }), 'structure/source-range-invalid'],
        ])('%s 被拒', (_label, fm, code) => {
            expect(codesOf(fm)).toContain(code);
        });

        it.each([
            ['非法 id（大写）', moduleFixture({ id: 'demo.Order' })],
            ['非法 id（空段）', moduleFixture({ id: 'demo..order' })],
            ['id 超长', moduleFixture({ id: 'a'.repeat(5000) })],
            ['parent 与 id 不一致', moduleFixture({ parent: 'other' })],
            ['name 缺 en', moduleFixture({ name: { zh: '订单' } })],
            ['description 空', moduleFixture({ description: { zh: '', en: '' } })],
            ['name 非双语对象', moduleFixture({ name: 'Order' })],
            ['uid 非 8 位 hex', moduleFixture({ uid: 'ZZZZ' })],
            ['revision 非 40 位 SHA', moduleFixture({ revision: 'abc' })],
            ['updated_at 非 ISO', moduleFixture({ updated_at: 'yesterday' })],
            ['未知顶层字段', moduleFixture({ bogus: 1 })],
            ['非法 state', moduleFixture({ state: 'draft' })],
        ])('%s 被拒', (_label, fm) => {
            expect(codesOf(fm).length).toBeGreaterThan(0);
        });
    });

    describe('原型污染面（__proto__ / constructor / prototype）', () => {
        it.each([
            ['JSON 解析出的 __proto__ 键', '{"__proto__": {"polluted": true}}'],
            ['constructor 键', '{"constructor": {"prototype": {"polluted": true}}}'],
            ['prototype 键', '{"prototype": {"polluted": true}}'],
        ])('%s 不污染 Object.prototype', (_label, json) => {
            const parsed = JSON.parse(json) as Record<string, unknown>;
            l1Validate({ ...moduleFixture(), ...parsed }, 'test/l1');
            expect(({} as Record<string, unknown>).polluted).toBeUndefined();
            expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
        });

        it('顶层 __proto__ 键被当作未知字段拒（不是静默接受）', () => {
            const fm = JSON.parse('{"__proto__": 1}') as Record<string, unknown>;
            const merged = { ...moduleFixture(), ...fm };
            const codes = codesOf(merged);
            expect(codes.length).toBeGreaterThan(0);
        });

        it('source 条目里的 __proto__ 同样被拒', () => {
            const errors: Diagnostic[] = [];
            const entry = JSON.parse('{"__proto__": {"path": "src/x.ts"}}') as unknown;
            expect(checkSourceEntry(entry, 'test/source/0', errors)).toBe(false);
            expect(({} as Record<string, unknown>).path).toBeUndefined();
        });

        it('parseModuleText 遇到 __proto__ 不污染原型', () => {
            const text = '---\nid: demo.x\nparent: demo\n__proto__: {polluted: true}\n---\nbody\n';
            parseModuleText(text, 'modules/demo/x.md');
            expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        });
    });

    describe('API / 依赖', () => {
        it('非 http 类带 method 被拒', () => {
            expect(codesOf(moduleFixture({ apis: [{ protocol: 'kafka', method: 'POST', path: 'q', description: { zh: '队列', en: 'Queue' } }] }))).toContain('api/method-forbidden');
        });

        it('http 类缺 method 被拒', () => {
            expect(codesOf(moduleFixture({ apis: [{ protocol: 'http', path: '/orders', description: { zh: '下单', en: 'Create order' } }] }))).toContain('api/method-required');
        });

        it('未知 protocol 被拒', () => {
            expect(codesOf(moduleFixture({ apis: [{ protocol: 'smoke-signal', path: 'p', description: { zh: '接口', en: 'API' } }] }))).toContain('api/protocol-unknown');
        });

        it('自环不是 L1 的职责（L1 只查形状/枚举；自环由批量写入与 L2 拦截）', () => {
            expect(codesOf(moduleFixture({ deps: [{ kind: 'call', to: 'demo.order' }] }))).toEqual([]);
        });

        it('未知 kind 被拒', () => {
            expect(codesOf(moduleFixture({ deps: [{ kind: 'magic', to: 'demo.other' }] }))).toContain('dep/kind-unknown');
        });
    });

    describe('checkSourceEntry 的路径围栏（fingerprint 与 L1 共用的同一校验器）', () => {
        it.each([
            '../x',
            'a/../../b',
            '/abs',
            'C:/abs',
            'a\\b',
            '',
            'a//b',
            './a',
        ])('%j 被拒', (path) => {
            const errors: Diagnostic[] = [];
            expect(checkSourceEntry({ path }, 'test/source/0', errors)).toBe(false);
            expect(errors[0]?.code).toBe('structure/source-path-invalid');
        });

        it.each([
            ['正常相对路径', 'src/order/payment.ts'],
            ['带行号', 'src/order.ts'],
        ])('%s 通过', (_label, path) => {
            const errors: Diagnostic[] = [];
            expect(checkSourceEntry({ path, line: 1, end_line: 9 }, 'test/source/0', errors)).toBe(true);
            expect(errors).toEqual([]);
        });
    });
});
