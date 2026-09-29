import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createToolRegistry } from '#/tools';

const PACKAGE_DIR = join(import.meta.dirname, '..');
const BUNDLE = join(PACKAGE_DIR, '..', '..', 'plugins', 'official', 'normify', 'bin', 'normify-mcp.mjs');
const MANIFEST = join(PACKAGE_DIR, '..', '..', 'plugins', 'official', 'normify', 'kimi.plugin.json');

/** 启动已提交的插件 bundle，走一轮真实 stdio JSON-RPC，取回 tools/list。 */
function listFromBundle(): Promise<{ name: string; description: string; inputSchema: unknown }[]> {
    const child = spawn(process.execPath, [BUNDLE], { stdio: ['pipe', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('bundle tools/list timed out'));
        }, 20_000);
        child.stdout.setEncoding('utf8');
        let buffer = '';
        child.stdout.on('data', (chunk: string) => {
            buffer += chunk;
            const parts = buffer.split('\n');
            buffer = parts.pop() ?? '';
            for (const line of parts) {
                if (line.trim() === '') continue;
                const msg = JSON.parse(line) as { id?: number; result?: { tools?: unknown[] } };
                if (msg.id === 2) {
                    clearTimeout(timer);
                    child.kill();
                    resolve((msg.result?.tools ?? []) as { name: string; description: string; inputSchema: unknown }[]);
                }
            }
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'drift-check', version: '0' } } }) + '\n');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    });
}

describe('插件 bundle 与 src 不漂移（B5）', () => {
    it('bundle 的 tools/list 与 src 注册表逐字段一致', async () => {
        const expected = createToolRegistry().map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
        }));
        const actual = await listFromBundle();
        expect(actual).toHaveLength(expected.length);
        for (const want of expected) {
            const got = actual.find(t => t.name === want.name);
            expect(got, 'bundle 缺少工具 ' + want.name).toBeDefined();
            expect(got?.description).toBe(want.description);
            expect(got?.inputSchema).toEqual(want.inputSchema);
        }
    }, 30_000);

    it('bundle 报告的 server 版本与 package.json 一致', async () => {
        const pkg = JSON.parse(await readFile(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string };
        const bundleText = await readFile(BUNDLE, 'utf8');
        expect(bundleText).toContain('version: "' + pkg.version + '"');
    });

    it('manifest 声明的 skills 目录真实存在（不是空指针）', async () => {
        const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as { skills?: string; mcpServers?: Record<string, { args?: string[] }> };
        expect(manifest.skills).toBe('./skills/');
        const skill = await readFile(join(dirname(MANIFEST), 'skills', 'normify-gen', 'SKILL.md'), 'utf8');
        expect(skill.startsWith('---')).toBe(true);
        expect(skill).toContain('name: normify-gen');
        expect(skill.length).toBeGreaterThan(1000);
    });

    it('manifest 指向的 MCP 入口就是被构建出来的那个文件', async () => {
        const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as { mcpServers: Record<string, { args: string[] }> };
        expect(manifest.mcpServers.normify?.args).toEqual(['./bin/normify-mcp.mjs']);
        await expect(readFile(BUNDLE, 'utf8')).resolves.toContain('createMcpServer');
    });

    it('bundle 是完整的构建产物：查看器模板 + MCP 入口都在', async () => {
        const bundleText = await readFile(BUNDLE, 'utf8');
        expect(bundleText).toContain('id="normify-data"');
        expect(bundleText).toContain('createMcpServer');
        expect(bundleText.length).toBeGreaterThan(100_000);
        // rolldown 会把模板字符串里的 `</` 写成 `<\/`（防止产物被内联进 HTML 时提前闭合
        // script）；渲染出来的 HTML 不受影响，这里只是记录这是构建器的转义、不是源码里的。
        expect(bundleText).toContain('<\\/script>');
    });

    it('bundle 不含裸的第三方 import（B6：插件必须在无 node_modules 的机器上启动）', async () => {
        // 回归：tsdown 默认把 package.json dependencies 外置，`yaml` 恰好是
        // normify 的依赖，于是产物带着 `import ... from "yaml"` 出厂——在开发
        // 机上永远复现不了（node_modules 就在手边），一到用户的
        // builtin-plugins 目录就 ERR_MODULE_NOT_FOUND。deps.alwaysBundle
        // 修复后，bundle 内不允许再出现任何裸包导入。
        const bundleText = await readFile(BUNDLE, 'utf8');
        const bareImports = [...bundleText.matchAll(/^import\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/gm)]
            .map(m => m[1])
            .filter((spec): spec is string => spec !== undefined)
            .filter(spec => !spec.startsWith('node:') && !spec.startsWith('.') && !spec.startsWith('/'));
        expect(bareImports, 'bundle 残留裸包导入: ' + JSON.stringify(bareImports)).toEqual([]);
    });
});
