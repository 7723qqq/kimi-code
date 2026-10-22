import { mock, setDefaultTimeout } from 'bun:test';

import pkg from '../package.json';
import './real-node-fs';
import { vscodeModule } from './vscode-host';

void mock.module('vscode', () => vscodeModule);

// `tsdown` replaces `__EXTENSION_VERSION__` at build time (see tsdown.config.ts).
// Defining it here gives the tests the same value the bundle would carry.
(globalThis as Record<string, unknown>)['__EXTENSION_VERSION__'] = pkg.version;

// Several tests drive a full engine turn or a real child process, which outlives Bun's
// 5s default per-test timeout.
setDefaultTimeout(15_000);
