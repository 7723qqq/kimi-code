/**
 * Banner component facade.
 *
 * Re-exports the opentui SolidJS implementation. Keeps the same exported
 * name (`BannerComponent`) as the v1 pi-tui class so callers that swap
 * imports land on the opentui renderable without churning their call sites.
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 */
export * from './banner.tsx'
