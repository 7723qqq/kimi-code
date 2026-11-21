import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const checker = require('vue-tsc');
const vueRequire = createRequire(require.resolve('vue-tsc'));
const transformerPath = vueRequire.resolve('@volar/typescript/lib/quickstart/runTsc');
const transformer = require(transformerPath);
const compiler = require.resolve('typescript-legacy/lib/_tsc.js');
transformer.runTsc = (path, extensions, getLanguagePlugins) => {
  transformer.getLanguagePlugins = getLanguagePlugins;
  const source = transformer.transformTscContent(
    readFileSync(path, 'utf8'),
    vueRequire.resolve('@volar/typescript/lib/node/proxyCreateProgram'),
    extensions,
    [],
    transformerPath,
  );
  const module = { exports: {}, filename: path };
  new Function('module', 'exports', 'require', '__filename', '__dirname', source)(
    module,
    module.exports,
    createRequire(path),
    path,
    dirname(path),
  );
};
checker.run(compiler);
