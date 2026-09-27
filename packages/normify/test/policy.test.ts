import { describe, expect, it } from 'vitest';

import { evaluatePolicy, isUnsafePattern, l1ValidatePolicy, matchIdPattern } from '#/engine/policy';
import { byCodeUnit } from '#/engine/ids';
import { l1Validate } from '#/engine/frontmatter';
import type { Dep, Module, ModuleFile, PolicyData } from '#/engine/types';

function mod(id: string, deps: { to: string; kind?: string }[] = [], state?: string): ModuleFile {
    const module: Module = {
        uid: id.replaceAll(/[^\w]/g, 'x').padEnd(8, '0'),
        id,
        parent: id.includes('.') ? id.split('.').slice(0, -1).join('.') : null,
        name: { zh: id, en: id },
        description: { zh: id, en: id },
        source: [{ path: 'src/' + id.replaceAll('.', '/') + '.ts' }],
        revision: '0'.repeat(40),
        updated_at: '2026-01-01T00:00:00.000Z',
        fingerprint: 'f'.repeat(64),
        ...(state !== undefined ? { state: state as Module['state'] } : {}),
        deps: deps.map(d => ({ kind: (d.kind ?? 'calls') as Dep['kind'], to: d.to })),
    };
    return { module, body: '', file: 'modules/' + id.replaceAll('.', '/') + '.md' };
}

function byIdOf(files: ModuleFile[]): Map<string, ModuleFile> {
    return new Map(files.map(f => [f.module.id, f]));
}

function evaluate(policy: PolicyData, files: ModuleFile[]): ReturnType<typeof evaluatePolicy> {
    return evaluatePolicy(policy, { files, byId: byIdOf(files) });
}

function policyOf(rules: Record<string, unknown>[]): ReturnType<typeof l1ValidatePolicy> {
    return l1ValidatePolicy({ schema_version: 1, updated_at: '2026-01-01T00:00:00.000Z', rules }, 'test/policy.yml');
}

function codes(result: ReturnType<typeof l1ValidatePolicy>): string[] {
    return result.errors.map(e => e.code);
}

describe('matchIdPattern（表驱动）', () => {
    const cases: [pattern: string, id: string, expected: boolean][] = [
        ['*', 'demo', true],
        ['*', 'demo.order', false],
        ['**', 'demo', true],
        ['**', 'demo.order.checkout', true],
        ['demo.*', 'demo.order', true],
        ['demo.*', 'demo.order.checkout', false],
        ['demo.**', 'demo.order.checkout', true],
        ['demo.**', 'demo', true],
        ['demo.*', 'demo', false],
        ['demo.order', 'demo.order', true],
        ['demo.order', 'demo.orders', false],
        ['a.*.*', 'a.b.c', true],
        ['a.*.*', 'a.b', false],
        ['*.order', 'demo.order', true],
    ];

    it.each(cases)('matchIdPattern(%j, %j) === %s', (pattern, id, expected) => {
        expect(matchIdPattern(pattern, id)).toBe(expected);
    });

    it('深 id 不会指数爆炸（** 与 40 段）', () => {
        const deep = Array.from({ length: 40 }, (_, i) => 's' + i).join('.');
        expect(matchIdPattern('**.**.**', deep)).toBe(true);
    });
});

describe('policy acyclic（表驱动）', () => {
    const acyclic = () => policyOf([{ id: 'core-acyclic', type: 'acyclic', severity: 'error' }]).policy!;

    it('无环：无诊断', () => {
        expect(evaluate(acyclic(), [mod('demo.a', [{ to: 'demo.b' }]), mod('demo.b')])).toEqual([]);
    });

    it('自环不由 acyclic 报（核心校验 dep/self-loop 负责，规则里显式跳过）', () => {
        expect(evaluate(acyclic(), [mod('demo.a', [{ to: 'demo.a' }])])).toEqual([]);
    });

    it('两节点环：报 1 条', () => {
        const diags = evaluate(acyclic(), [mod('demo.a', [{ to: 'demo.b' }]), mod('demo.b', [{ to: 'demo.a' }])]);
        expect(diags.length).toBe(1);
        expect(diags[0]?.code).toContain('core-acyclic');
    });

    it('三节点环：仍只报 1 条（按规范环键去重）', () => {
        const files = [
            mod('demo.a', [{ to: 'demo.b' }]),
            mod('demo.b', [{ to: 'demo.c' }]),
            mod('demo.c', [{ to: 'demo.a' }]),
        ];
        expect(evaluate(acyclic(), files).length).toBe(1);
    });

    it('同 id 多份文件只报一次', () => {
        const a = mod('demo.a', [{ to: 'demo.b' }]);
        const b = mod('demo.b', [{ to: 'demo.a' }]);
        expect(evaluate(acyclic(), [a, { ...a }, { ...b }]).length).toBe(1);
    });

    it('enabled:false 的规则不执行', () => {
        const policy = policyOf([{ id: 'core-acyclic', type: 'acyclic', severity: 'error', enabled: false }]).policy!;
        expect(evaluate(policy, [mod('demo.a', [{ to: 'demo.a' }])])).toEqual([]);
    });

    it('includeCrossTree:false 时跨树环不报', () => {
        const policy = policyOf([{ id: 'core-acyclic', type: 'acyclic', severity: 'error', includeCrossTree: false }]).policy!;
        expect(evaluate(policy, [mod('alpha.a', [{ to: 'beta.b' }]), mod('beta.b', [{ to: 'alpha.a' }])])).toEqual([]);
    });
});

describe('policy naming（表驱动 + ReDoS 闸门 A7）', () => {
    const naming = (pattern: string) => policyOf([{ id: 'core-naming', type: 'naming', severity: 'error', pattern }]);
    const evalNaming = (pattern: string, files: ModuleFile[]) => {
        const parsed = naming(pattern);
        expect(codes(parsed)).toEqual([]);
        return evaluate(parsed.policy!, files);
    };

    it.each([
        ['^[a-z][a-z0-9-]*$', 'demo.order', 0],
        ['^[a-z][a-z0-9-]*$', 'Demo.order', 1],
        ['^d', 'demo', 0],
        ['^x', 'demo', 1],
        ['^[0-9]+$', 'demo', 1],
    ])('pattern %j 对 %j → %i 条', (pattern, id, expected) => {
        expect(evalNaming(pattern, [mod(id)]).length).toBe(expected);
    });

    it('逐段检查：只有违规段报 1 条', () => {
        const diags = evalNaming('^[a-z]+$', [mod('demo.Order')]);
        expect(diags.length).toBe(1);
        expect(String(diags[0]?.evidence?.segment)).toBe('Order');
    });

    it('scope 限定后范围外的模块不检查', () => {
        const parsed = policyOf([{ id: 'core-naming', type: 'naming', severity: 'error', pattern: '^x$', scope: ['other.*'] }]);
        expect(codes(parsed)).toEqual([]);
        expect(evaluate(parsed.policy!, [mod('demo.a')])).toEqual([]);
    });

    it.each([
        ['量词包分组', '(a+)+$'],
        ['组内量词再包一层', '(a*)*b'],
        ['组内分支', '(a|a)*$'],
        ['非捕获组被量词包裹', '(?:ab)+c'],
        ['相邻量词', '\\d+\\.?\\d*\\d+$'],
        ['叠加量词', 'a**'],
        ['量词后再次量词', '[a-z]+*'],
        ['重复次数过大', '^a{1,999}$'],
        ['反向引用', '^(a)\\1+$'],
        ['环视', '^(?=x)a+$'],
    ])('危险 pattern 被拒：%s', (_label, pattern) => {
        expect(isUnsafePattern(pattern)).toBe(true);
        expect(codes(naming(pattern))).toContain('policy/rule-pattern-unsafe');
    });

    it('超长 pattern 被拒（>200 字符）', () => {
        const pattern = '^' + 'a'.repeat(220) + '$';
        expect(codes(naming(pattern))).toContain('policy/rule-pattern-unsafe');
    });

    it.each([
        ['^[a-z][a-z0-9-]*$'],
        ['^v[0-9]{1,2}$'],
        ['^(a|b)c$'],
        ['^[a-z]+[0-9]?$'],
    ])('线性 pattern 放行：%s', (pattern) => {
        expect(isUnsafePattern(pattern)).toBe(false);
        expect(codes(naming(pattern))).toEqual([]);
    });

    it('不安全 pattern 即使绕过写入也不会被执行（evaluate 侧兜底）', () => {
        const policy = { schema_version: 1, updated_at: 'x', rules: [{ id: 'core-naming', type: 'naming' as const, pattern: '(a+)+$' }] };
        expect(evaluate(policy, [mod('demo.a')])).toEqual([]);
    });

    it('合法 pattern 真的不会被误伤（回归：默认模板里的示例）', () => {
        expect(isUnsafePattern('^[a-z][a-z0-9-]*$')).toBe(false);
    });
});

describe('policy 其它规则（表驱动）', () => {
    const files = [mod('demo.a', [{ to: 'demo.b' }]), mod('demo.b', [], 'deprecated')];

    it('forbid-dependency + toState 命中废弃目标', () => {
        const policy = policyOf([{ id: 'no-deprecated', type: 'forbid-dependency', from: ['**'], to: ['**'], toState: 'deprecated', severity: 'warning' }]).policy!;
        expect(evaluate(policy, files).length).toBe(1);
    });

    it('max-depth 越界', () => {
        const policy = policyOf([{ id: 'depth', type: 'max-depth', maxDepth: 1, severity: 'error' }]).policy!;
        expect(evaluate(policy, files).length).toBe(2);
    });

    it('cross-tree forbid 命中', () => {
        const cross = [mod('alpha.a', [{ to: 'beta.b' }]), mod('beta.b')];
        const policy = policyOf([{ id: 'no-cross', type: 'cross-tree', mode: 'forbid', severity: 'error' }]).policy!;
        expect(evaluate(policy, cross).length).toBe(1);
    });

    it('cross-tree require-to-api 缺 to_api 时命中', () => {
        const cross = [mod('alpha.a', [{ to: 'beta.b' }]), mod('beta.b')];
        const policy = policyOf([{ id: 'cross-api', type: 'cross-tree', mode: 'require-to-api', severity: 'error' }]).policy!;
        expect(evaluate(policy, cross).length).toBe(1);
    });

    it('缺 maxDepth / 非法 mode / 缺 pattern 都在 L1 被拒', () => {
        expect(codes(policyOf([{ id: 'd', type: 'max-depth' }]))).toContain('policy/rule-max-depth-missing');
        expect(codes(policyOf([{ id: 'c', type: 'cross-tree', mode: 'nope' }]))).toContain('policy/rule-mode');
        expect(codes(policyOf([{ id: 'n', type: 'naming' }]))).toContain('policy/rule-pattern');
    });

    it('非法正则 / 未知 type / 重复 id / 非 kebab id 被拒', () => {
        expect(codes(policyOf([{ id: 'n', type: 'naming', pattern: '([' }]))).toContain('policy/rule-pattern-invalid');
        expect(codes(policyOf([{ id: 'x', type: 'nope' }]))).toContain('policy/rule-type');
        expect(codes(policyOf([{ id: 'a-b', type: 'acyclic' }, { id: 'a-b', type: 'acyclic' }]))).toContain('policy/rule-id-duplicate');
        expect(codes(policyOf([{ id: 'Bad_Id', type: 'acyclic' }]))).toContain('policy/rule-id');
    });

    it('非法 from/to 模式字符集被拒（PATTERN_CHARS）', () => {
        expect(codes(policyOf([{ id: 'a', type: 'forbid-dependency', from: ['../x'] }]))).toContain('policy/rule-patterns');
    });
});

describe('byCodeUnit 与 sort 默认序一致（打包后类型擦除也保留显式比较器）', () => {
    it('与默认码元序相同', () => {
        const items = ['b', 'a', 'C', 'a-1', 'a', 'a_b'];
        expect(items.toSorted()).toEqual(items.toSorted(byCodeUnit));
    });

    it('相等返回 0', () => {
        expect(byCodeUnit('a', 'a')).toBe(0);
    });
});

describe('L1 模块校验不受 policy 改动影响', () => {
    it('合法计划态模块通过 L1', () => {
        const r = l1Validate({
            uid: 'abcd1234',
            id: 'demo.order',
            parent: 'demo',
            name: { zh: '订单', en: 'Order' },
            description: { zh: '订单域', en: 'Order domain' },
            source: [{ path: 'src/order.ts' }],
            revision: '0'.repeat(40),
            updated_at: '2026-01-01T00:00:00.000Z',
            fingerprint: 'pending',
            state: 'planned',
        }, 'test/module');
        expect(r.errors).toEqual([]);
        expect(r.module?.id).toBe('demo.order');
    });
});
