import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { plugin } from 'bun';
import ts from 'typescript-legacy';
import { compileScript, compileTemplate, parse as parseVue } from 'vue/compiler-sfc';

const root = resolve(import.meta.dir, '..');
const repoRoot = resolve(root, '..', '..');
const namespace = 'desktop-test-scope';
const exclusions = new Map<string, Set<string>>();
let nextScope = 0;

const SHARED_SOURCE_RE = /^packages[\\/](?:app-[^\\/]+|i18n[^\\/]*|vite-preset)[\\/]/;

function isDesktopSource(filename: string): boolean {
  const path = relative(root, filename);
  if (
    !isAbsolute(path) &&
    !path.startsWith(`..${sep}`) &&
    path !== '..' &&
    /^(src|native)[\\/]/.test(path)
  ) {
    return /\.(?:ts|mjs|vue)$/.test(path);
  }
  const shared = relative(repoRoot, filename);
  return (
    !isAbsolute(shared) &&
    !shared.startsWith(`..${sep}`) &&
    shared !== '..' &&
    SHARED_SOURCE_RE.test(shared) &&
    /\.(?:ts|mjs|vue)$/.test(shared)
  );
}

function scopedSpecifier(scope: string, filename: string): string {
  return `${namespace}:${scope}:${filename.replaceAll('\\', '/')}`;
}

function scopeSource(text: string, filename: string, scope: string): string {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const edits: Array<{ start: number; end: number; value: string }> = [];
  function visit(node: ts.Node): void {
    if (
      ts.isStringLiteral(node) &&
      (((ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) &&
        node.parent.moduleSpecifier === node) ||
        (ts.isCallExpression(node.parent) &&
          node.parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.parent.arguments[0] === node)) &&
      node.text.startsWith('.')
    ) {
      const target = Bun.resolveSync(node.text, dirname(filename));
      const value =
        isDesktopSource(target) && !exclusions.get(scope)?.has(target)
          ? scopedSpecifier(scope, target)
          : target.replaceAll('\\', '/');
      edits.push({ start: node.getStart(source), end: node.end, value: JSON.stringify(value) });
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.kind === ts.SyntaxKind.MetaProperty
    ) {
      const value =
        node.name.text === 'dir'
          ? dirname(filename)
          : node.name.text === 'path'
            ? filename
            : node.name.text === 'url'
              ? Bun.pathToFileURL(filename).href
              : undefined;
      if (value !== undefined)
        edits.push({ start: node.getStart(source), end: node.end, value: JSON.stringify(value) });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const edit of edits.sort((a, b) => b.start - a.start))
    text = `${text.slice(0, edit.start)}${edit.value}${text.slice(edit.end)}`;
  return text;
}

plugin({
  name: namespace,
  setup(builder) {
    builder.onLoad({ filter: /^\d+:/, namespace }, async ({ path }) => {
      const boundary = path.indexOf(':');
      const filename = path.slice(boundary + 1);
      if (!isDesktopSource(filename))
        throw new Error(`Test module must remain inside Desktop source: ${filename}`);
      let source = await Bun.file(filename).text();
      if (filename.endsWith('.vue')) {
        const { descriptor, errors } = parseVue(source, { filename });
        if (errors.length > 0) throw new Error(`${filename}: ${errors.join('\n')}`);
        const id = new Bun.CryptoHasher('sha256').update(filename).digest('hex').slice(0, 8);
        const scoped = descriptor.styles.some((style) => style.scoped);
        const script =
          descriptor.script || descriptor.scriptSetup
            ? compileScript(descriptor, { id, genDefaultAs: '__component', fs: ts.sys })
            : undefined;
        const contents = [script?.content ?? 'const __component = {};'];
        if (descriptor.template) {
          const template = compileTemplate({
            source: descriptor.template.content,
            filename,
            id,
            scoped,
            compilerOptions: { bindingMetadata: script?.bindings },
          });
          if (template.errors.length > 0)
            throw new Error(`${filename}: ${template.errors.join('\n')}`);
          contents.push(template.code, '__component.render = render;');
        }
        if (scoped) contents.push(`__component.__scopeId = ${JSON.stringify(`data-v-${id}`)};`);
        contents.push('export default __component;');
        source = contents.join('\n');
      }
      return {
        contents: scopeSource(source, filename, path.slice(0, boundary)),
        loader: filename.endsWith('.mjs') ? 'js' : 'ts',
      };
    });
  },
});

export function createDesktopModuleScope(testUrl: string, mockedModules: readonly string[] = []) {
  const base = dirname(fileURLToPath(testUrl));
  const mocked = new Set(
    mockedModules.filter((path) => path.startsWith('.')).map((path) => Bun.resolveSync(path, base)),
  );
  let scope = String(nextScope++);
  exclusions.set(scope, mocked);
  return {
    reset(): void {
      scope = String(nextScope++);
      exclusions.set(scope, mocked);
    },
    load<T>(path: string): Promise<T> {
      const filename = Bun.resolveSync(path, base);
      if (!isDesktopSource(filename))
        throw new Error(`Test module must remain inside Desktop source: ${filename}`);
      return import(scopedSpecifier(scope, filename)) as Promise<T>;
    },
  };
}
