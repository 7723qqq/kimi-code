/**
 * `storage` domain barrel — compatibility re-export.
 *
 * Re-exports from the new canonical locations in `persistence/`.
 * Existing consumers that import from `#/app/storage` continue to work
 * without changes.
 */

export * from '#/persistence/interface/storage';
export * from '#/persistence/interface/appendLogStore';
export * from '#/persistence/interface/atomicDocumentStore';
export * from '#/persistence/interface/queryStore';
export * from '#/persistence/backends/node-fs/fileStorageService';
export * from '#/persistence/backends/memory/inMemoryStorageService';
export * from '#/persistence/backends/node-fs/appendLogStore';
export * from '#/persistence/backends/node-fs/atomicDocumentStore';
