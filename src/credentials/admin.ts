/**
 * The owner-facing credential API (ADR 0024). Routes import this module, never src/credentials/store.ts: it does not
 * export getCredentialForAdapter, which returns a plaintext secret and is for server-side adapters only. The ESLint rule
 * in eslint.config.mjs enforces that routes and model-facing tools reach the store through here alone.
 */
export {
  setCredential,
  listConnectors,
  revokeCredential,
  verifyCredential,
  CONNECTOR_KINDS,
  CredentialInputError,
  CredentialNotFoundError,
  type ConnectorKind,
  type ConnectorStatus,
  type ConnectorSummary,
  type CredentialActor,
  type VerifyOutcome,
} from "./store.js";
export { CredentialStoreDisabledError } from "./crypto.js";
