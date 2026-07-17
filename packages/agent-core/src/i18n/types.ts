export type Locale = 'en' | 'zh';

export type MessageValue = string | { [k: string]: MessageValue };

type Join<K, P> = K extends string | number
  ? P extends string | number
    ? `${K}.${P}`
    : never
  : never;

type Paths<T> = T extends MessageValue
  ? T extends string
    ? never
    : { [K in keyof T]-?: Join<K, Paths<T[K]>> | K }[keyof T]
  : never;

export type TranslationKey = Paths<typeof import('./en').default>;
