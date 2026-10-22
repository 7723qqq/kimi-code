import { mock } from 'bun:test';
import * as fs from 'node:fs';

// The preload imports this module before any test file runs, so `fs` here is
// the real module even in a file that later calls `mock.module('node:fs', ...)`.
// That snapshot is what a mock has to spread to stay transparent.
export const realNodeFs = fs;
export const realStatSync = fs.statSync;

// `statSync` is the only export a test replaces: Bun cannot spy on a module
// namespace, so the replacement has to be installed through `mock.module`.
export const statSyncMock = mock(realStatSync);
