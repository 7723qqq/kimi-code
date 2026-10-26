type DeepPartial<T> = T extends string ? string : T extends object ? {
    [K in keyof T]?: DeepPartial<T[K]>;
} : never;
export declare const zh: DeepPartial<typeof import('./en').default>;
export default zh;
