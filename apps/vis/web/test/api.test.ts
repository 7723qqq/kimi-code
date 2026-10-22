import { afterEach, describe, expect, it, mock } from 'bun:test';

import { api } from '../src/api';
import { setGlobal, restoreGlobals } from './_helpers/bunTest';

describe('vis web api auth token handling', () => {
  afterEach(() => {
    restoreGlobals();
  });

  it('scrubs token parameters from the browser URL after persisting the token', async () => {
    const setItem = mock();
    const getItem = mock();
    const replaceState = mock();
    const location = new URL('http://localhost:3001/?foo=bar&token=secret#token=secret&tab=wire');

    setGlobal('window', {
      history: { replaceState },
      localStorage: { getItem, setItem },
      location,
    });
    const fetchMock = mock(
      async () =>
        new Response('[]', {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
    );
    setGlobal('fetch', fetchMock);

    await api.listSessions();

    expect(setItem).toHaveBeenCalledWith('kimi-vis-auth-token', 'secret');
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions', {
      headers: { accept: 'application/json', authorization: 'Bearer secret' },
      method: 'GET',
    });
    expect(replaceState).toHaveBeenCalledWith(null, '', 'http://localhost:3001/?foo=bar#tab=wire');
  });
});
