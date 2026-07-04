# Feature-module conventions for the kimi-web prototype

You are writing **one self-contained feature module** for the from-scratch kimi-web
prototype at `apps/kimi-web2/`.

## First, read these to match conventions
- `index.html` — app shell + modal/overlay structure + the `<div id="feature-mount">` mount.
- `styles.css` — token vars (`--c-*`, `--r-*`, `--s-*`), components (`.btn`, `.seg`, `.sw`, `.field`, `.menu`, `.modal`, `.overlay`).
- `data.js` — `window.Store` data + API.
- `app.js` — event-delegation pattern, helpers, `window.KP`.

## Output
Write **only** your feature file(s), never the shared files:
- `prototype/features/<NAME>.js` (required)
- `prototype/features/<NAME>.css` (only if your feature needs new rules not already in `styles.css`)

Do **not** edit `index.html`, `styles.css`, `data.js`, or `app.js`.

## Helpers (already on `window`)
`window.KP = { Store, esc, icon, t, toast, openOverlay, closeOverlays, confirm, renderAll }`
- `Store` — data + state (see below).
- `esc(s)` — HTML-escape.
- `icon(id, cls?)` — `<svg><use href="#id"/></svg>` (ids come from the sprite in `index.html`; reuse existing ids like `i-close`, `i-search`, `i-check`, `i-star`, `i-shield`, `i-external`, `i-copy`, `i-chevron-down`, `i-dots`, `i-folder`).
- `toast(msg, kind?)` — transient toast.
- `openOverlay(name)` / `closeOverlays()` — open/close an overlay whose root is `[data-overlay="name"]`.
- `confirm({ title, message, okLabel?, danger?, onConfirm })` — generic confirm dialog.
- `renderAll()` — re-render the base shell.

`Store` shape (read freely; mutate via `Store.set({...})` when appropriate):
- `Store.workspaces` `[{id,name,root,branch,add,del}]`
- `Store.sessions` `[{id,ws,title,ago,busy,unread,pending:{a,q}}]`
- `Store.conversations` `{sessionId: [blocks]}`
- `Store.models` `[{id,name,provider,starred,thinking}]`
- `Store.config` `{defaultModel,defaultPermission,defaultThinking,defaultPlanMode,mergeSkills,telemetry,serverVersion,daemon}`
- `Store.state` `{currentSessionId,theme,fontSize,lang,permission,modelId,planMode,swarmMode,rightPanel,collapsed,expanded,authed}`
- `Store.set(patch)`, `Store.session(id)`, `Store.workspace(id)`, `Store.model(id)`, `Store.relTime(ago)`, `Store.subscribe(fn)`

## Patterns
- **Overlay/dialog:** inject
  `<div class="overlay" data-overlay="<name>"><section class="modal <...>" role="dialog" aria-modal="true">…</section></div>`
  into `#feature-mount`. Open with `openOverlay('<name>')`. Backdrop click + Esc already close overlays (handled in `app.js`); add a `[data-close]` button to close.
- **Self-wire:** add your own `document` listeners inside your module (do not touch `app.js`). Use `data-act` attributes + a delegated `document` click listener for your elements.
- **Tokens only:** colors via `var(--c-*)`, radius `var(--r-*)`, spacing `var(--s-*)`, fonts `var(--font-sans)`/`var(--font-mono)`. **No** hardcoded hex / fonts / gradients / glassmorphism.
- **Buttons/controls:** reuse `.btn .btn-primary|.btn-secondary|.btn-danger`, `.seg` (segmented), `.sw` (switch), `.field` (input), `.badge`, `.menu/.mi` — see `styles.css`.
- **Calm, fill-based:** hairline `0.5px var(--c-sep)` separators; state via fill, not borders; near-black emphasis.

## Entry point
Expose a way to open/init your feature, e.g. `window.KP_open<Name> = openFn`, and/or self-wire to a trigger selector (e.g. `document` click on `[data-open-<name>]`). Return a short summary with your entry point(s) and the file(s) you wrote.
