
// `vscode` is provided by the Extension Host, not by a package on disk. Bun
// resolves the static import graph of a test file before that file's own
// `mock.module` calls run, so the specifier must already be registered when the
// preload executes. Bun also ignores a later `mock.module('vscode', ...)` for
// that exact specifier, so tests that need a specific host API replace the
// surface below instead of re-mocking the module.
type VscodeSurface = Record<string, unknown>;

let installed: VscodeSurface | undefined;

export function installVscode(surface: VscodeSurface): void {
  installed = surface;
}

function resolveMember(name: string): unknown {
  if (installed === undefined) {
    throw new Error(
      `vscode.${name} was used before this test file called installVscode(...) from test/vscode-host.ts.`,
    );
  }
  if (!(name in installed)) {
    throw new Error(`vscode.${name} was used but installVscode(...) did not provide it.`);
  }
  return installed[name];
}

// Each exported member stays a live view of the installed surface: the members
// are bound when the test file's imports are linked, which happens before the
// test body installs its surface.
function forwarder(name: string): unknown {
  return new Proxy(function vscodeMember() {}, {
    get(_target, property) {
      const host = resolveMember(name) as Record<PropertyKey, unknown>;
      const value = host[property];
      return typeof value === 'function' ? value.bind(host) : value;
    },
    apply(_target, _thisArg, args: unknown[]) {
      return (resolveMember(name) as (...a: unknown[]) => unknown)(...args);
    },
    construct(_target, args: unknown[]) {
      return Reflect.construct(resolveMember(name) as new (...a: unknown[]) => object, args);
    },
  });
}

const MEMBERS = [
  'AuthenticationProvider',
  'CancellationTokenSource',
  'CodeAction',
  'CodeActionKind',
  'ColorThemeKind',
  'CompletionItemKind',
  'ConfigurationTarget',
  'Diagnostic',
  'DiagnosticSeverity',
  'Disposable',
  'EndOfLine',
  'EventEmitter',
  'ExtensionMode',
  'FileChangeType',
  'FileSystemError',
  'FileType',
  'Hover',
  'Location',
  'LogLevel',
  'MarkdownString',
  'OverviewRulerLane',
  'Position',
  'ProgressLocation',
  'QuickPickItemKind',
  'Range',
  'RelativePattern',
  'Selection',
  'SnippetString',
  'StatusBarAlignment',
  'SymbolKind',
  'TextEdit',
  'ThemeColor',
  'ThemeIcon',
  'TreeItem',
  'TreeItemCollapsibleState',
  'UIKind',
  'Uri',
  'ViewColumn',
  'WorkspaceEdit',
  'authentication',
  'chat',
  'commands',
  'comments',
  'debug',
  'env',
  'extensions',
  'languages',
  'lm',
  'notebooks',
  'notifications',
  'scm',
  'tasks',
  'tests',
  'window',
  'workspace',
];

export const vscodeModule = Object.fromEntries(MEMBERS.map((name) => [name, forwarder(name)]));
