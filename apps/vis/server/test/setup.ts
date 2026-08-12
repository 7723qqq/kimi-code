// apps/vis/server/test/setup.ts
//
// Test baseline: legacy fixture tests target the retired directory layout.
// The `auto` source would resolve against the real machine's engine home
// (e.g. `~/.kimi-code/agent/sessions.db`) and leak host sessions into the
// fixtures, so the legacy source is the default here unless a test opts
// into the SQLite source explicitly (vi.stubEnv('KIMI_VIS_SOURCE', 'sqlite')
// overrides this value for the duration of that test file).

process.env['KIMI_VIS_SOURCE'] ??= 'legacy';
