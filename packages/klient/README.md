# @moonshot-ai/klient

Client SDK that reuses `agent-core-v2` service interfaces and fulfills them over
the `/api/v2` HTTP channel. It follows the VS Code model: a channel is bound to
**one Service** (the URL carries the scope + the Service's decorator id) and
method calls are forwarded **verbatim** to the server's reflection dispatcher —
no per-method allowlist, no `resource:action`, no renaming. The shared interface
is the whole contract.

```ts
import { Klient, SessionIndexClient, HttpChannel } from '@moonshot-ai/klient';
import { ISessionIndex } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';

const client = new Klient({ url: 'http://127.0.0.1:58627' });

// Generic typed proxy: the v2 service token carries both the type and the
// channel name (`String(ISessionIndex)` === 'sessionIndex').
const sessions = await client.core(ISessionIndex).list({});
const meta = await client.session('s1').service(ISessionMetadata).read();

// Explicit, fully-typed implementation of a single interface. The channel is
// bound to the Service's scope URL.
const index: ISessionIndex = new SessionIndexClient(
  new HttpChannel({ baseUrl: 'http://127.0.0.1:58627/api/v2/sessionIndex' }),
);
const page = await index.list({ workspaceId: 'w1' });
```

Service interfaces and tokens are imported directly from `agent-core-v2` leaf
subpaths; the channel and proxy live in this package. WebSocket events
(`listen`) are out of scope for this scaffold — HTTP only carries `call`.
