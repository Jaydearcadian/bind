import { generateKeyPairSync } from "node:crypto";
import { createPrivyVerifier } from "../../src/accounts/privy.js";

/** A real ES256 verifier keyed with a generated key, for tests that need the account routes to be configured (ADR 0051). */
const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
export const testPrivyVerifier = createPrivyVerifier({
  appId: "app_test_helper",
  verificationKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
});
