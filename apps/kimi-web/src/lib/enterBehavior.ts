// apps/kimi-web/src/lib/enterBehavior.ts
// Composer Enter behavior while the session is busy: 'queue' (Enter enqueues
// the message, the default) or 'steer' (Enter pushes the text straight into
// the running turn, like Ctrl+S). Local UI preference, persisted in
// localStorage — mirrors deepseek-harness's submission-settings (MIT).

export type EnterBehavior = 'queue' | 'steer';

const STORAGE_KEY = 'kimi-web.enter-behavior';

export function getEnterBehavior(): EnterBehavior {
  if (typeof localStorage === 'undefined') return 'queue';
  return localStorage.getItem(STORAGE_KEY) === 'steer' ? 'steer' : 'queue';
}

export function setEnterBehavior(value: EnterBehavior): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, value);
}
