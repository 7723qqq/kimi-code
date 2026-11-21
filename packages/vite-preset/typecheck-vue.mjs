import { resolve } from 'node:path';

import { proxyCreateProgram } from '@volar/typescript/lib/node/proxyCreateProgram.js';
import { createParsedCommandLine, createVueLanguagePlugin, getAllExtensions } from '@vue/language-core';
import ts from 'typescript';

const configPath = resolve(process.argv[2] ?? 'tsconfig.json').replaceAll('\\', '/');
const { vueOptions } = createParsedCommandLine(ts, ts.sys, configPath);
const extensions = getAllExtensions(vueOptions).map((extension) => ({
  extension: extension.slice(1),
  isMixedContent: true,
  scriptKind: ts.ScriptKind.Deferred,
}));
const formatHost = {
  getCanonicalFileName: (name) => name,
  getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
  getNewLine: () => ts.sys.newLine,
};
function reportDiagnostics(diagnostics) {
  if (diagnostics.length === 0) return;
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost));
  process.exitCode = 1;
}
const config = ts.getParsedCommandLineOfConfigFile(
  configPath,
  { noEmit: true, declaration: false },
  { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (error) => reportDiagnostics([error]) },
  undefined,
  undefined,
  extensions,
);
if (config && config.errors.length === 0) {
  const { fileNames: rootNames, projectReferences } = config;
  const options = { ...config.options, allowNonTsExtensions: true };
  const createProgram = proxyCreateProgram(ts, ts.createProgram, () => [
    createVueLanguagePlugin(ts, options, vueOptions, (name) => name),
  ]);
  const program = createProgram({ rootNames, options, host: ts.createCompilerHost(options), projectReferences });
  reportDiagnostics(ts.getPreEmitDiagnostics(program));
} else if (config) {
  reportDiagnostics(config.errors);
}
