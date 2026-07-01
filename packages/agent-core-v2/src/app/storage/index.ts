/**
 * `storage` domain barrel — re-exports the byte-store contract and its
 * access-pattern facades. Importing this barrel registers the in-memory
 * `IStorageService` / `IAppendLogStorage` / `IAtomicDocumentStorage` backends,
 * the `IAtomicDocumentStore` / `IAtomicTomlDocumentStore` stores, and the
 * `IAppendLogStore` store into the scope registry.
 */

export * from './storageService';
export * from './fileStorageService';
export * from './inMemoryStorageService';
export * from './appendLogStore';
export * from './atomicDocumentStore';
export * from './queryStore';
