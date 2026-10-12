import { Component, type ReactNode } from 'react';

/** Last-resort net under the whole app. Without it a render-time throw (e.g.
 *  from a malformed imported wire record) unmounts the React root and leaves
 *  a blank page until the user reloads. Individual readers guard their own
 *  payloads; this only catches what slips through. */
export class RootErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="font-mono text-[13px] text-[var(--color-sev-error)]">
          vis crashed while rendering
        </div>
        <pre className="max-w-[80ch] whitespace-pre-wrap break-words font-mono text-[11px] text-fg-1">
          {error.message}
        </pre>
        <button
          type="button"
          onClick={() => {
            window.location.reload();
          }}
          className="border border-border bg-surface-1 px-3 py-1 font-mono text-[11px] text-fg-0 hover:border-border-strong"
        >
          reload
        </button>
      </div>
    );
  }
}
