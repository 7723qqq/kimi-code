import type { Component } from "../tui.ts";

export interface NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined;
	getNativeScrollbackCommitSafeEnd?(): number | undefined;
	getNativeScrollbackSnapshotSafeEnd?(): number | undefined;
}

export interface NativeScrollbackCommittedRows {
	setNativeScrollbackCommittedRows(rows: number): void;
}

export interface RenderStablePrefix {
	getRenderStablePrefixRows(): number;
}

export function getNativeScrollbackLiveRegionStart(component: Component): number | undefined {
	return (component as Component & Partial<NativeScrollbackLiveRegion>).getNativeScrollbackLiveRegionStart?.();
}

export function getNativeScrollbackCommitSafeEnd(component: Component): number | undefined {
	return (component as Component & Partial<NativeScrollbackLiveRegion>).getNativeScrollbackCommitSafeEnd?.();
}

export function getNativeScrollbackSnapshotSafeEnd(component: Component): number | undefined {
	return (component as Component & Partial<NativeScrollbackLiveRegion>).getNativeScrollbackSnapshotSafeEnd?.();
}

export function setNativeScrollbackCommittedRows(component: Component, rows: number): void {
	(component as Component & Partial<NativeScrollbackCommittedRows>).setNativeScrollbackCommittedRows?.(rows);
}

export function getRenderStablePrefixRows(component: Component): number | undefined {
	return (component as Component & Partial<RenderStablePrefix>).getRenderStablePrefixRows?.();
}
