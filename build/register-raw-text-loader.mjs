import { register } from 'node:module';

/**
 * Registers the `?raw` text loader. Pass to Bun via `--import` so
 * source-executed code can import text files.
 */
register('./raw-text-loader.mjs', import.meta.url);
