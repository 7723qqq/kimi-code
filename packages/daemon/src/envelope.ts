/**
 * Re-export the envelope helpers from `@moonshot-ai/protocol`.
 *
 * W4.3 (P0.13) consolidates the wire-shape source-of-truth in protocol. The
 * daemon previously hand-rolled `okEnvelope` / `errEnvelope` / `Envelope`
 * with byte-identical output to protocol's helpers (verified by W1 reviewer
 * against packages/protocol/src/__tests__/envelope.test.ts); flipping the
 * import preserves field order and JSON output exactly.
 *
 * Keep this file as a re-export shim (not a direct re-export from the package
 * barrel) so downstream `from './envelope'` imports inside the daemon stay
 * stable and don't all need to be touched.
 */
export { okEnvelope, errEnvelope, type Envelope } from '@moonshot-ai/protocol';
