/**
 * `modelCatalog` domain barrel — re-exports the model-catalog contract
 * (`modelCatalog`) and its scoped service (`modelCatalogService`). Importing
 * this barrel registers the `IModelCatalogService` binding into the scope
 * registry and self-registers the domain's error codes.
 */

export * from './configSection';
export * from './modelCatalog';
export * from './modelCatalogService';
