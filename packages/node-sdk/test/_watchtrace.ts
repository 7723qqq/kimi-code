import fs from 'node:fs';

const original = fs.watch.bind(fs) as typeof fs.watch;
(fs as unknown as { watch: unknown }).watch = (...args: unknown[]) => {
  const stack = new Error('watch created').stack ?? '';
  const frame = stack.split('\n').filter((l) => l.includes('packages') || l.includes('.mjs') || l.includes('.ts:')).slice(1, 5).join('\n');
  console.error('[WATCH]', String(args[0]), '\n' + frame);
  return (original as (...a: unknown[]) => unknown)(...args);
};
