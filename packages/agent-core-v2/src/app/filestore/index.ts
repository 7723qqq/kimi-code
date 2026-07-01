/**
 * `filestore` domain barrel — re-exports the file-store contract, its errors,
 * and the App-scoped implementation. Importing this barrel registers the
 * `IFileStore` binding and the file error codes into the scope/error registries.
 */

export * from './errors';
export * from './filestore';
export * from './fileStoreService';
