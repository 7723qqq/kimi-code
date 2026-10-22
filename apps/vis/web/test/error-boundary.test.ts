import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'bun:test';

import { RootErrorBoundary } from '../src/components/shared/RootErrorBoundary';

// Audit a37/F2 fallback — without a boundary, a render-time throw unmounts the
// React root and the whole app goes blank. The boundary must render a readable
// error card instead. (React does not run error boundaries during SSR, so this
// drives the component's own render directly with a caught error.)
describe('RootErrorBoundary', () => {
  it('renders its children while there is no error', () => {
    const boundary = new RootErrorBoundary({ children: null });
    expect(boundary.render()).toBeNull();
  });

  it('renders an error card with the message instead of a blank page', () => {
    const boundary = new RootErrorBoundary({ children: null });
    boundary.state = { error: new Error('boom while rendering') };

    const markup = renderToStaticMarkup(boundary.render() as never);

    expect(markup).toContain('vis crashed while rendering');
    expect(markup).toContain('boom while rendering');
    expect(markup).toContain('reload');
    expect(markup).not.toBe('');
  });

  it('captures a thrown error into state', () => {
    const error = new Error('nope');
    expect(RootErrorBoundary.getDerivedStateFromError(error)).toEqual({ error });
  });
});
