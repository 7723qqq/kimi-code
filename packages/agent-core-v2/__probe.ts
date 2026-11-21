import ignore from 'ignore';
const rules = ['ignored-app.ts', '', 'node_modules/'];
const m = ignore({ allowRelativePaths: true }).add(rules);
console.log('ignores ignored-app.ts =>', m.ignores('ignored-app.ts'));
console.log('ignores src/app.ts     =>', m.ignores('src/app.ts'));
const m2 = ignore({ allowRelativePaths: true }).add('ignored-app.ts\n');
console.log('add(string) same       =>', m2.ignores('ignored-app.ts'));
