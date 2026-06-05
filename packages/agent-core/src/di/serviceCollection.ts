/**
 * `ServiceCollection` is the unordered map of service-id → (descriptor | instance)
 * used to seed an `InstantiationService`. It's a thin wrapper over `Map` whose
 * value type is `SyncDescriptor<T> | T` — the container decides which based on
 * `instanceof SyncDescriptor`.
 */

import type { SyncDescriptor } from './descriptors';
import type { ServiceIdentifier } from './instantiation';

export class ServiceCollection {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _entries = new Map<ServiceIdentifier<any>, SyncDescriptor<any> | any>();

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...entries: ReadonlyArray<readonly [ServiceIdentifier<any>, SyncDescriptor<any> | any]>
  ) {
    for (const [id, value] of entries) {
      this._entries.set(id, value);
    }
  }

  /**
   * Set an entry. Returns the previous value (or `undefined` if the id was
   * not previously set).
   */
  set<T>(
    id: ServiceIdentifier<T>,
    instanceOrDescriptor: T | SyncDescriptor<T>,
  ): T | SyncDescriptor<T> | undefined {
    const prev = this._entries.get(id);
    this._entries.set(id, instanceOrDescriptor);
    return prev;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  has(id: ServiceIdentifier<any>): boolean {
    return this._entries.has(id);
  }

  get<T>(id: ServiceIdentifier<T>): T | SyncDescriptor<T> | undefined {
    return this._entries.get(id);
  }

  /** Iterate all entries. Order is insertion-order (Map semantics). */
  forEach(
    callback: (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      id: ServiceIdentifier<any>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value: SyncDescriptor<any> | any,
    ) => void,
  ): void {
    this._entries.forEach((value, id) => callback(id, value));
  }
}
