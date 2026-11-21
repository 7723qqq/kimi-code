export const FFIType = {
  ptr: 'ptr',
  i32: 'i32',
  u32: 'u32',
  bool: 'bool',
} as const;

export function dlopen(): never {
  throw new Error('bun:ffi is only available to the Bun backend, not to Electron main');
}
