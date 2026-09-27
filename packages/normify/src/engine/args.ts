/**
 * MCP 入参校验：注册表把 `def.parameters`（编译后的 JSON Schema）交给这里，
 * 在执行器之前做类型/未知键/体量检查。
 *
 * 存在的理由：宿主传进来的是模型生成的 JSON，只有"键存在且非空"这一层校验时，
 * `dry_run: "false"`（字符串）会让 `=== true` 落空 → 静默真实写入；`items` / `body`
 * 这类大参数也没有上限，长驻 stdio 进程里一次调用就能吃掉整棵树的内存。
 */

/** 校验用到的 JSON Schema 节点（结构上与 tools.ts 的 SchemaNode 兼容：required 在作者态是 boolean）。 */
export interface ArgSchemaNode {
    type?: string;
    enum?: unknown[];
    items?: ArgSchemaNode;
    properties?: Record<string, ArgSchemaNode>;
    required?: string[] | boolean;
    additionalProperties?: boolean;
    [key: string]: unknown;
}

/** 批量入参的体量上限（超出即拒绝，避免长驻进程被单次调用打爆）。 */
export const LIMITS = {
    /** 数组类参数（items / source / order / groups / edge_hints / files …）的最大条目数。 */
    arrayItems: 500,
    /** 单个自由文本字段（body / task / message / acceptance …）的最大字符数。 */
    textLength: 200_000,
    /** 单个对象类参数（frontmatter / patch / root / proposal）的最大 JSON 字节数。 */
    objectBytes: 1024 * 1024,
    /** 整个入参的最大 JSON 字节数。 */
    totalBytes: 4 * 1024 * 1024,
} as const;

export type ArgResult = { ok: true; args: Record<string, unknown> } | { ok: false; code: string; message: string };

const BOOL_STRINGS = new Map<string, boolean>([
    ['true', true],
    ['false', false],
    ['1', true],
    ['0', false],
]);

function typeName(value: unknown): string {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return 'array';
    return typeof value;
}

function byteLength(value: unknown): number {
    try {
        return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
    }
    catch {
        return Number.POSITIVE_INFINITY;
    }
}

/** 布尔位（dry_run / direct_only / activate / enable …）的字符串归一：模型爱传 "true"/"false"。 */
export function coerceBoolean(value: unknown): { ok: true; value: boolean } | { ok: false; message: string } {
    if (typeof value === 'boolean')
        return { ok: true, value };
    if (typeof value === 'string') {
        const hit = BOOL_STRINGS.get(value.trim().toLowerCase());
        if (hit !== undefined)
            return { ok: true, value: hit };
    }
    return { ok: false, message: '必须是布尔值（true/false）' };
}

/** 单个值的类型检查（未知键 / 缺失由上层负责）。 */
function checkValue(key: string, schema: ArgSchemaNode, value: unknown, out: string[]): unknown {
    const type = schema.type;
    if (type === undefined)
        return value;
    if (type === 'boolean') {
        const coerced = coerceBoolean(value);
        if (!coerced.ok) {
            out.push(key + ': ' + coerced.message);
            return value;
        }
        return coerced.value;
    }
    if (type === 'string') {
        if (typeof value !== 'string') {
            out.push(key + ': 必须是 string（实际 ' + typeName(value) + '）');
            return value;
        }
        if (value.length > LIMITS.textLength)
            out.push(key + ': 超过 ' + LIMITS.textLength + ' 字符上限（实际 ' + value.length + '）');
        if (Array.isArray(schema.enum) && !schema.enum.includes(value))
            out.push(key + ': 必须是 ' + JSON.stringify(schema.enum) + ' 之一');
        return value;
    }
    if (type === 'number' || type === 'integer') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            out.push(key + ': 必须是 ' + type + '（实际 ' + typeName(value) + '）');
            return value;
        }
        if (type === 'integer' && !Number.isInteger(value))
            out.push(key + ': 必须是整数');
        return value;
    }
    if (type === 'array') {
        if (!Array.isArray(value)) {
            out.push(key + ': 必须是 array（实际 ' + typeName(value) + '）');
            return value;
        }
        if (value.length > LIMITS.arrayItems)
            out.push(key + ': 超过 ' + LIMITS.arrayItems + ' 条上限（实际 ' + value.length + '）');
        const items = schema.items;
        if (items?.type !== undefined && items.type !== 'object') {
            for (const [i, entry] of value.entries()) {
                if (items.type === 'string' && typeof entry !== 'string')
                    out.push(key + '[' + i + ']: 必须是 string（实际 ' + typeName(entry) + '）');
                else if (items.type === 'number' && (typeof entry !== 'number' || !Number.isFinite(entry)))
                    out.push(key + '[' + i + ']: 必须是 number');
            }
        }
        return value;
    }
    if (type === 'object') {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            out.push(key + ': 必须是 object（实际 ' + typeName(value) + '）');
            return value;
        }
        if (byteLength(value) > LIMITS.objectBytes)
            out.push(key + ': 超过 ' + LIMITS.objectBytes + ' 字节上限');
        return value;
    }
    return value;
}

/** 递归检查已编译 schema（对象/数组/标量），返回归一化后的入参副本。 */
function walk(schema: ArgSchemaNode, value: unknown, prefix: string, out: string[]): unknown {
    const checked = checkValue(prefix, schema, value, out);
    if (schema.type === 'array' && Array.isArray(checked)) {
        const items = schema.items;
        // items 声明了子字段（source / apis / groups / edge_hints）时逐条下钻；
        // 自由对象数组（items 本身）不校验内部形状，交给各工具自己的 L1。
        if (items?.properties === undefined)
            return checked;
        return checked.map((entry, i) => entry === null ? entry : walk(items, entry, prefix + '[' + i + ']', out));
    }
    if (schema.type === 'object' && typeof checked === 'object' && checked !== null && !Array.isArray(checked)) {
        const source = checked as Record<string, unknown>;
        const next: Record<string, unknown> = { ...source };
        const properties = schema.properties;
        for (const [key, entry] of Object.entries(source)) {
            const child = properties?.[key];
            // `parent` 允许显式 null（根模块），其余未知/多余键一律拒绝。
            if (child === undefined) {
                if (schema.additionalProperties === false && entry !== null)
                    out.push((prefix === '' ? '' : prefix + '.') + key + ': 不支持的参数');
                continue;
            }
            if (entry === null)
                continue;
            next[key] = walk(child, entry, (prefix === '' ? '' : prefix + '.') + key, out);
        }
        return next;
    }
    return checked;
}

/**
 * 校验一次 `tools/call` 的 arguments：未知键、类型、体量。
 * `parent` 的显式 null 被保留（根模块语义），其余必填/未知键问题在此之前由注册表判存在性。
 */
export function validateArgs(schema: ArgSchemaNode | undefined, rawArgs: unknown): ArgResult {
    const given = (rawArgs ?? {}) as Record<string, unknown>;
    if (typeof given !== 'object' || Array.isArray(given))
        return { ok: false, code: 'args/shape', message: 'arguments 必须是对象' };
    const problems: string[] = [];
    let args: Record<string, unknown> = given;
    if (schema === undefined) {
        if (Object.keys(args).length > 0)
            problems.push('该工具不接受任何参数：' + Object.keys(args).join(', '));
    }
    else {
        args = walk(schema, args, '', problems) as Record<string, unknown>;
    }
    if (byteLength(args) > LIMITS.totalBytes)
        problems.push('arguments 超过 ' + LIMITS.totalBytes + ' 字节上限');
    if (problems.length > 0)
        return { ok: false, code: 'args/invalid', message: problems.join('; ') };
    return { ok: true, args };
}
