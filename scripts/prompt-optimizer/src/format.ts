/**
 * Prompt Optimizer — shared formatting helpers.
 *
 * Each report module used to carry its own copy of these.
 */

export function padRight(str: string, len: number): string {
  return str.length >= len ? str + ' ' : str + ' '.repeat(len - str.length);
}

export function formatNum(n: number): string {
  return n < 10 ? n.toFixed(3) : n.toFixed(1);
}

export function sign(val: string): string {
  return Number(val) >= 0 ? `+${val}` : val;
}

export function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
