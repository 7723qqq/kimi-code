export type {
  ServiceIdentifier,
  ServicesAccessor,
  ServiceCollectionLike,
  BrandedService,
  IConstructorSignature,
  GetLeadingNonServiceArgs,
} from './instantiation';
export {
  createDecorator,
  refineServiceDecorator,
  IInstantiationService,
} from './instantiation';
export { SyncDescriptor } from './descriptors';
export type { SyncDescriptor0 } from './descriptors';
export { ServiceCollection } from './serviceCollection';
export { InstantiationService } from './instantiationService';
export {
  Disposable,
  DisposableStore,
  DisposableMap,
  DisposableSet,
  MutableDisposable,
  DisposableTracker,
  combinedDisposable,
  toDisposable,
  dispose,
  disposeIfDisposable,
  disposeOnReturn,
  isDisposable,
  markAsSingleton,
  setDisposableTracker,
  trackDisposable,
  markAsDisposed,
} from './lifecycle';
export type { IDisposable, IDisposableTracker } from './lifecycle';
export { CyclicDependencyError } from './errors';
export {
  InstantiationType,
  registerSingleton,
  getSingletonServiceDescriptors,
  _clearRegistryForTests,
} from './extensions';
