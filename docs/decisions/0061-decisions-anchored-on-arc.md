# 0061: Decisions are anchored on Arc

Status: Accepted as a direction (2026-10-20), by the owner. Nothing new is built.

## Context
Every commercial decision already gets a deterministic SHA-256 `decisionHash` over its evidence (`src/agents/bindTemplateAgent.ts`), written to local evidence files (`STATE_ANCHOR.md`, `DECISION_EVIDENCE.md`) and the audit log. Nothing is written on chain today. The owner decided that decisions settle on Arc too, alongside payments (ADR 0060).

## Decision (direction)
- Each decision that matters (a policy decision on a commitment, an owner approval or rejection, a revocation, and later agent-to-agent agreements) gets a tamper-evident record on Arc, so anyone holding the evidence can prove it existed unchanged at that time.
- **Only commitments go on chain, never content.** A public chain is permanent and readable by anyone: no amounts, supplier or customer names, items, prices or free text are written there. The chain holds a hash; the evidence stays in Bind.
- Recommended shape, to confirm when built: hashes batched per workspace into a Merkle root on a short interval (fees and throughput), with each decision keeping its proof path, so one transaction covers many decisions and any single decision can be verified on its own. Salted hashes so a guessable decision cannot be confirmed by brute force.
- Anchoring never gates the business: a decision takes effect when Bind's policy decides, and the anchor follows. The app says "Recorded on Arc" only after the anchoring transaction is confirmed, and shows "Recording" until then. A failed anchor is retried and visible, never silently dropped.

## To decide before building
- Which decisions are anchored (all audit rows, or only commitments and owner decisions).
- Whether to use an existing Arc primitive (for example a validation or attestation registry referenced in ADR 0001) or a plain transaction carrying the root; a custom contract only if neither serves, following `docs/CONTRACT_SCOPE.md`.
- Who signs and pays for anchoring transactions (a Bind-operated key per environment, or per workspace).
- How an owner, auditor or counterparty verifies a decision (a proof download and a public checker).
- Legal and privacy review of what a hash of business data reveals.

## Sequencing (agreed 2026-10-20)
1. Finish the product first (app, sign-in, demo, a first accounting connector).
2. Now and cheaply: a tamper-evident decision log inside Bind (each decision's hash includes the previous one, so any edit breaks the chain).
3. When the first outside party needs to trust the record (auditor, counterparty, another business's agent): anchor those hashes on Arc.
4. When a ramp provider is chosen and legal advice is in: fiat on and off ramps, one country and currency first, invoice payment kept as the default for suppliers who will not take stablecoins.
