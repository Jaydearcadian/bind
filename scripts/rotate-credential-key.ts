/**
 * Re-encrypts every live connector credential under the current key (ADR 0024). Set BIND_CREDENTIAL_KEY to the new key and
 * BIND_CREDENTIAL_KEY_PREVIOUS to the old one, run this, then remove the previous key. Prints counts only, never a key or a
 * secret. Exits non-zero if any row could not be re-encrypted.
 *
 * Usage: npm run credentials:rotate-key
 */
import { config } from "../src/config/env.js";
import { closePool } from "../src/db/client.js";
import { rotateCredentialKeys } from "../src/credentials/store.js";

async function main(): Promise<void> {
  if (!config.BIND_CREDENTIAL_KEY || !config.BIND_CREDENTIAL_KEY_PREVIOUS) {
    console.error(
      "Set BIND_CREDENTIAL_KEY (the new key) and BIND_CREDENTIAL_KEY_PREVIOUS (the old key) before rotating. No key is printed."
    );
    process.exitCode = 1;
    return;
  }
  const report = await rotateCredentialKeys();
  console.log(`rotated=${report.rotated} skipped=${report.skipped} failed=${report.failed}`);
  if (report.failed > 0) {
    console.error(`${report.failed} credential(s) could not be re-encrypted and were left unchanged.`);
    process.exitCode = 1;
  }
}

main()
  .catch(() => {
    console.error("Credential key rotation failed.");
    process.exitCode = 1;
  })
  .finally(() => closePool());
