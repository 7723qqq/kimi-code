import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { plugin } from 'bun';
import ts from 'typescript';

const sourceRoot = resolve(import.meta.dir, '../src');
const namespace = 'app-client-test-scope';
const pathPrefix = '../src/';
let nextScope = 0;

function isAppClientSource(filename: string): boolean {
  const path = relative(sourceRoot, filename);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`) && path.endsWith('.ts');
}

function scopedSpecifier(scope: string, filename: string): string {
  return `${namespace}:${scope}:${filename.replaceAll('\\', '/')}`;
}

function scopeImports(text: string, filename: string, scope: string): string {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const edits: Array<{ start: number; end: number; value: string }> = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    if (ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly : statement.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    if (specifier.text.startsWith('~icons/')) {
      edits.push({ start: specifier.getStart(source), end: specifier.end, value: JSON.stringify(`kimi-icon:${specifier.text}`) });
    } else if (specifier.text.startsWith('.')) {
      const target = Bun.resolveSync(specifier.text, dirname(filename));
      const value = isAppClientSource(target) ? scopedSpecifier(scope, target) : target.replaceAll('\\', '/');
      edits.push({ start: specifier.getStart(source), end: specifier.end, value: JSON.stringify(value) });
    }
  }
  for (const edit of edits.reverse()) {
    text = `${text.slice(0, edit.start)}${edit.value}${text.slice(edit.end)}`;
  }
  return text;
}

plugin({
  name: namespace,
  setup({ onLoad }) {
    onLoad({ filter: /^\d+:/, namespace }, async ({ path }) => {
      const boundary = path.indexOf(':');
      const filename = path.slice(boundary + 1);
      if (!isAppClientSource(filename)) throw new Error(`Test module must remain inside app-client/src: ${filename}`);
      const text = await Bun.file(filename).text();
      return { contents: scopeImports(text, filename, path.slice(0, boundary)), loader: 'ts' };
    });
  },
});

export function createAppClientModuleScope() {
  let scope = String(nextScope++);
  return {
    reset(): void { scope = String(nextScope++); },
    load<T>(path: `../src/${string}`): Promise<T> {
      const filename = Bun.resolveSync(`./${path.slice(pathPrefix.length)}`, sourceRoot);
      return import(scopedSpecifier(scope, filename)) as Promise<T>;
    },
  };
}
