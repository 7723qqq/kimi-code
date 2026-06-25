/**
 * `wireRecord` domain barrel - re-exports the wireRecord service contract and implementation.
 */

export * from './persistence';
export * from './wireRecord';
export * from './wireRecordService';
export * from './migration/index';

export interface WireRecordMap {}

export type WireRecord<K extends keyof WireRecordMap = keyof WireRecordMap> = {
  [T in K]: { readonly type: T; readonly time?: number } & Readonly<WireRecordMap[T]>;
}[K];
