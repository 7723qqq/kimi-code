/**
 * `model` domain barrel — re-exports the model contract (`model`) and its scoped
 * service (`modelService`). Importing this barrel registers the `IModelService`
 * binding into the scope registry, which registers the `models` config section
 * and the `KIMI_MODEL_*` effective overlay.
 */

export * from './model';
export * from './modelService';
