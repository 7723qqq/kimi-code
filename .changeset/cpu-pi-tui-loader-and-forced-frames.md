---
"@moonshot-ai/pi-tui": patch
---

Two render-loop lifecycle fixes.

**A spinner is no longer a reason for the host process to stay alive.** `Loader` armed its animation interval in the constructor and never unref'd it, so a host that merely constructed one got a repeating timer that kept the event loop open and kept repainting a TUI whose owner had stopped caring. The interval is unref'd and `Loader` now exposes `dispose()`; `CancellableLoader` inherits it and loses its identical copy. Construction still arms the animation, because both in-repo users rely on that and never call `start()`.

**The forced-render path obeys the same re-arm bound as the scheduled path.** `requestRender(true)` reset the previous-frame caches and then re-rendered from a `process.nextTick` without consulting the clean-frame bound, and it could not consult it: a forced frame always repaints every row and always reports output, so the output test cannot tell a runaway forced chain from live state. A component that forced a render from inside its own render therefore chained 0 ms frames forever. The forced path now carries its own counter — the first frame is still delivered immediately, a request the frame raised itself is answered at most once, then dropped — so a host forced render always starts a fresh chain.
