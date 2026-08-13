/**
 * Re-export the envelope helpers from the local `protocol` module.
 *
 * Keep this file as a re-export shim so downstream `from './envelope'`
 * imports inside the server stay stable and don't all need to be touched.
 */
export {
  errEnvelope,
  internalErrorEnvelope,
  okEnvelope,
  setExposeErrorDetails,
  type Envelope,
} from './protocol/envelope';
