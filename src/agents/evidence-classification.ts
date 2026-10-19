/**
 * Evidence class for a request's status report.
 *
 * The remote-verified class is deliberately not a possible output: it would mean a
 * remote mutation was completed and independently verified, and no code path here
 * reads a chain receipt itself. An arc-testnet request is LIVE_READ_PASS only when its order is
 * `reconciled`, which the procurement flow reaches only after a settlement receipt
 * was read; anything earlier is NOT_RUN.
 */
export type RequestEvidenceClass = "LOCAL_PASS" | "LIVE_READ_PASS" | "NOT_RUN";

export function classifyRequestEvidence(input: {
  settlementMode: string;
  orderStatus: string | null;
}): RequestEvidenceClass {
  if (input.settlementMode !== "arc-testnet") {
    return "LOCAL_PASS";
  }
  if (input.orderStatus === "reconciled") {
    return "LIVE_READ_PASS";
  }
  return "NOT_RUN";
}
