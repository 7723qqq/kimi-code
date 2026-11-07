import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ErrorCodes } from '#/errors';

const PKG = join(import.meta.dirname, '..');
const OUT = join(PKG, 'src', '_base', 'errors', 'errorCode.generated.ts');

const codes = [...new Set(Object.values(ErrorCodes))].sort();
const body = codes.map((code) => `  '${code}',`).join('\n');
writeFileSync(OUT, `export const ERROR_CODE_UNION = [\n${body}\n] as const;\n`, 'utf8');
console.log(`gen-error-codes: wrote ${codes.length} codes to ${OUT}`);
