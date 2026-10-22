# ADR 0077: The live-check revert gates call from a funded sender

## Status
Accepted (2026-10-22), on the owner's instruction in this session. Changes `scripts/verify-live-arc.ts` (ADR 0039) without weakening any gate.

## Context
The live run of 2026-10-22 showed gates 4 and 5 (unapproved supplier, daily cap) not passing. Both gates simulate `settleOrder` with `cast call` and a
value. With no sender, the caller is the zero address with no balance, so the node reverts with a generic `Error(string)` (`0x08c379a0`) before the
contract's own checks run. With the funded owner as sender the same calls revert with the expected custom errors (`0x65e822e9` and `0xef664d6a`). The
gates were testing the wrong thing, not finding a contract defect.

## Decision
- Both revert calls pass `--from <sender>`. The sender is `ARC_SIGNER_ADDRESS` (a public address) or is derived in-process from
  `ARC_SIGNER_PRIVATE_KEY` with viem. Real `cast wallet address` cannot take a key from the environment, so the derivation does not use `cast` and the key
  never appears in an argument or a child environment. Child environments also have the known secret variable names removed.
- A gate still passes only when the expected revert selector appears. A generic revert, a wrong selector or a call that succeeds does not pass.
- No sender, an invalid or zero address, an address that does not match the key, or a key that cannot be parsed makes both gates BLOCKED with a fixed reason
  that never shows the value. There is no silent fallback.
- The two earlier non-passing results stay recorded in `docs/RELEASE_EVIDENCE.md` as they were.

## Consequences
The gates now test the contract's own checks. The sender is not proven to be funded; the selector is the criterion. The script remains read-only.
