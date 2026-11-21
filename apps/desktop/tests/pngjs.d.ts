declare module 'pngjs' {
  export const PNG: {
    readonly sync: {
      read(data: Uint8Array): {
        readonly width: number;
        readonly height: number;
        readonly data: import('node:buffer').Buffer;
      };
    };
  };
}
