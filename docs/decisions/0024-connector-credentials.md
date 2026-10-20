# ADR 0024: Connector credentials are encrypted at rest, owner-only, and reported honestly; one redaction module

## Status
Accepted (2026-10-20). Implements Task 7a of `docs/superpowers/plans/2026-10-19-bind-completion-plan.md`. Builds on ADR 0021
(owner tokens, the audit actor is the token label), ADR 0022 (webhook secrets are derived from a master secret; this ADR
does not change that) and ADR 0016 (`src/ui/` untouched). The notification recipient and approval link are Task 7b.

## Context
A business has to hold keys that belong to it: a supplier API key, a WhatsApp or email token, an accounting connection.
Before this change there was nowhere to put them, and secret hiding was scattered:
- `WorkflowEngine.sanitizeEvidence` hid values by key name only (`/secret|token|password|private_key|key/`). It hid
  `idempotencyKey` and missed a secret inside a string.
- `src/effects/ledger.ts` kept its own `knownSecrets()` list.
- `src/adapters/settlement/errors.ts` had `redactSecrets`, and `arc-l1.ts` and `circleAgentStack.ts` have their own URL scrubbing.

AGENTS.md requires that credentials never reach a model or an untrusted plugin, and that tool output, documents and supplier
responses are treated as untrusted.

## Decision

### Storage (`connector_credentials`, additive)
- One row per `(workspace_id, connector_id)`. The secret is AES-256-GCM ciphertext with a fresh random 12-byte nonce, a
  16-byte tag, and the id of the key that encrypted it. `src/credentials/crypto.ts`.
- Additional authenticated data is `${workspaceId}:${connectorId}`. A ciphertext copied to another workspace or connector
  fails to authenticate.
- `key_id` is the first 8 hex characters of SHA-256 of the key bytes. Never the key.
- `fingerprint` is 12 hex characters of an HMAC of the secret, under a key derived from the credential key with the
  domain string `bind-credential-fingerprint-v1`. The derivation keeps the encryption key from doubling as an HMAC key.
  It identifies a secret without revealing it. Rotation recomputes it under the new key.
- Revocation keeps the row and its status, and sets `ciphertext`, `nonce`, `auth_tag`, `key_id` and `fingerprint` to NULL.
  The secret is destroyed, not kept.

### Keys and configuration
- `BIND_CREDENTIAL_KEY`: base64 of exactly 32 bytes, validated at load. A wrong length or a non-base64 value stops startup
  with an error that names the variable and never the value. `BIND_CREDENTIAL_KEY_PREVIOUS` has the same format and is
  decrypt-only, for rotation.
- There is no default key in source. The vitest config carries two fixed test-only keys, used by no other environment.
- With no `BIND_CREDENTIAL_KEY` the store is disabled. Every store function throws `CredentialStoreDisabledError`, and the
  four routes answer `503 { "error": "Credential store is not configured" }`.
- The keyring is read from configuration at call time, not at import. A key change takes effect on the next call.

### Store (`src/credentials/store.ts`)
- `setCredential` upserts. A second call replaces the ciphertext, nonce, tag, key id and fingerprint, and resets status to
  `configured_unverified` with `last_verified_at` NULL. The old secret is gone.
- `listConnectors` returns summaries only.
- `revokeCredential` destroys the secret and sets status `revoked`. It returns null for an unknown connector.
- `getCredentialForAdapter` is **server-side only**. It returns the plaintext. It does no caching. It returns null for a missing
  or revoked row. It is not exported from `src/credentials/admin.ts`, and an ESLint `no-restricted-imports` rule forbids
  importing `src/credentials/store` from `src/server/**` and `src/agents/**`. An integration test (`getCredentialForAdapter is
  not reachable from routes or tools`) runs ESLint's `lintText` on probe files and checks that the rule fires, and that the
  admin module is allowed.

### Verification (honest status)
- `verifyCredential` runs the verifier registered for the connector id, or else for its kind, on the decrypted secret, in process.
  The registry (`src/credentials/verifiers.ts`) starts empty. **No live connector exists yet, so nothing can become
  `verified`.**
- Only an `{ ok: true }` result writes `verified`, and it writes it only if the row still holds the ciphertext that was
  verified (the nonce is unique per encryption). A replaced or revoked credential cannot be marked verified by a verification
  of its predecessor.
- A failure, a thrown error, or a result that is not an explicit ok returns the status to `configured_unverified`.
  `last_verified_at` is kept as the last successful time.
- With no verifier, the answer is `NOT_AVAILABLE` and the stored status is returned unchanged. No audit row is written.
- A verifier's error text goes through `redactText` with the secret, is cut to 200 characters, and is stored in the audit
  evidence as `reason`. The response carries a code only. A returned code must match `^[A-Z][A-Z0-9_]{0,63}$` and must not
  contain the secret, or it is replaced by `VERIFIER_INVALID_RESULT`.

### Routes (owner only; `...workspaceOwner`)
| Method | Path | Access | Response |
|---|---|---|---|
| GET | `/api/workspaces/:id/connectors` | owner | list of summaries |
| PUT | `/api/workspaces/:id/connectors/:connectorId` | owner | 200 summary; body `{ kind, secret }` |
| DELETE | `/api/workspaces/:id/connectors/:connectorId` | owner | 200 summary with status `revoked`; 404 if unknown |
| POST | `/api/workspaces/:id/connectors/:connectorId/verify` | owner | 200 `{ connectorId, status, verification, code? }` |

- Staff get 403. Another workspace's token gets 404 (`scopeToWorkspace`).
- Invalid connector id, kind, empty or oversize secret: 400. The message names the rule and never the value.
- The actor is `{ type: "owner", id: req.actor.label }`.
- Routes reach the store only through `src/credentials/admin.ts`.
- The route table in `tests/integration/auth-tenancy.test.ts` lists the four routes as owner routes.

### Audit
- `connector.credential_set`, `connector.credential_revoked` and `connector.credential_rotated` are `commercial_commitment`,
  following the owner-configuration precedent (`workspace.onboard_configured`, ADR 0021 tokens).
- `connector.credential_verified` and `connector.credential_verification_failed` are `external_request`, because they call
  out to a supplier.
- Evidence holds `connectorId`, `kind`, `fingerprint`, `code`, and the redacted `reason` on a thrown verifier. Never the secret.
- Rotation writes its audit rows under the actor `system:credential-rotation`.

### Redaction (`src/utils/redact.ts`, one module)
- `redactText(text, extraSecrets)`. It replaces:
  - every extra secret of any non-empty length, and every configured secret of at least 8 characters (the environment's
    secret names, `DATABASE_URL`, `RPC_URL`, `ARC_RPC_URL`);
  - the password of each of those connection URLs, on its own, because a driver error can print the password alone;
  - workspace tokens (`bnd_` plus 43 or more characters) with `[redacted-token]`;
  - a bearer value with `Bearer [redacted]`;
  - a `0x` 64-hex private key assigned to a `private key` label. The label stays and a bare transaction hash does not match;
  - a URL that carries userinfo, a credential query parameter, or an opaque path segment of 20 or more characters, as
    `[redacted-url]`. A plain URL stays.
- `redactDeep(value, extraSecrets)` copies a value. It redacts every string, and replaces the value of a key that names a secret
  with `[REDACTED]`. A key names a secret when its last word is `secret, token, password, passphrase, credential(s),
  authorization or cookie`, or its last two words are `api key, private key, secret key, access key, auth token or signing
  key`. Cycle-safe, depth 8, never throws.
- `keyNamesSecret` keeps `idempotencyKey`, `publicKey`, `keyId`, `tokenId`, `txHash`, `matchHash` and `orderId`.
- `redactUrls` replaces every URL. Error messages use it before `redactText`. The reason: the brief keeps plain URLs in
  `redactText` (its test asserts that), but the settlement guard test (`redact-secrets.test.ts`) and the effects-ledger guard
  test require every URL in an error message to become `[redacted-url]`, including a URL whose path is a short token. So
  `redactSecrets` in `settlement/errors.ts` and `boundedErrorMessage` in `effects/ledger.ts` are `redactText(redactUrls(...))`.
- `WorkflowEngine.sanitizeEvidence` is replaced by `redactDeep`. `boundedErrorMessage` redacts before it cuts to 500 characters,
  so a secret is never left half-visible at the cut.
- `arc-l1.ts` and `circleAgentStack.ts` keep their own URL scrubbing. They are outside this task's file list and are a follow-up.

### Rotation (`npm run credentials:rotate-key`)
- With `BIND_CREDENTIAL_KEY` (new) and `BIND_CREDENTIAL_KEY_PREVIOUS` (old) both set, `rotateCredentialKeys` re-encrypts every
  live row whose `key_id` is not the current one. Each row is its own transaction, with `SELECT ... FOR UPDATE`. Rows already
  under the current key are skipped.
- A row that cannot be decrypted is counted as failed and left unchanged. The script prints counts only, and exits 1 if any row failed.
- Once the rotation has run, the previous key can be removed. The integration test checks this by clearing the previous key and
  decrypting every row.

## Threat model

| Threat | What stops it |
|---|---|
| Database leak (backup, read replica, SQL access) | Only ciphertext, nonce, tag, key id and HMAC fingerprint are stored. The key is not in the database. The seeded-secret test checks that the plaintext appears in no column. |
| Wrong tenant | The workspace id is part of the AAD, and every lookup is on `(workspace_id, connector_id)`. A ciphertext moved to another workspace fails to authenticate. Routes check the token's workspace (404). |
| Log leak (console, error body, audit, effect row, workflow error) | Every write path goes through `redactText` or `redactDeep`. Responses carry summaries and fixed messages. The integration test scans audit rows, effects, workflows, the connector table, every response body and console output for the seeded secret. |
| Model or tool leak | No model-facing file imports the store, and the ESLint rule enforces this for `src/agents/**`. Tool output and supplier responses go through the same redaction. |
| Stale or fake "verified" | `verified` is written only by a passing registered verifier, and only for the ciphertext that was verified. |
| Key rotation leaves old ciphertext | Rotation re-encrypts every live row. The previous key is decrypt-only and is removed afterwards. |

## What is NOT protected
- A compromised server process holds the credential key in memory and can decrypt everything. Encryption at rest is not
  protection against code execution on the server.
- One environment key is the single point of failure until a KMS or HSM holds it. A leak of `BIND_CREDENTIAL_KEY` with the database
  exposes every credential. Rotation is possible, but it is a manual procedure.
- No live verifier exists, so no credential is `verified`. Verification is untested against a real supplier.
- The owner's identity is the token label (ADR 0021), not a verified person. The audit actor inherits that limit.
- A verifier is trusted in-process code. A verifier that logs its input would leak it. Verifiers are reviewed code only.
- A secret shorter than 8 characters is still replaced when it is an extra secret. A configured secret shorter than 8
  characters is not replaced.

## Platform keys stay environment variables
The LLM provider keys (`NEBIUS_API_KEY`, `GEMINI_API_KEY`, `PARALLEL_API_KEY`, `LANGSMITH_API_KEY`) and the Arc signer key
(`ARC_SIGNER_PRIVATE_KEY`) are platform credentials. The platform operator owns them, not the business. They are used by the
platform's own agents and settlement, and no workspace can supply or read them. Storing them per workspace would give a
business access to a platform key, and would let one tenant's configuration change what the platform signs or spends. They
therefore stay environment variables. They are included in the redaction set so they never reach stored text.

## Consequences
- Adding a supplier adapter means: store its key with `setCredential` (owner), register a verifier for its id or kind at
  start-up, and read the key with `getCredentialForAdapter` on the server.
- Status can honestly read `configured_unverified` for every credential until a verifier exists.
- The redaction module is the one place to extend when a new secret name appears.

## Test evidence
The tests are `tests/unit/redaction.test.ts` (12), `tests/unit/credential-crypto.test.ts` (7) and
`tests/integration/credentials.test.ts` (14: the 13 titles in the brief, plus one for a row that cannot be decrypted during
rotation). The exact commands and counts are in the Task 7a report. `docs/RELEASE_EVIDENCE.md` is updated in a release step,
as ADR 0022 noted.
