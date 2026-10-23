import { config } from "../config/env.js";

/**
 * A plain link to the approval page in the app. It carries no token and no query string, and opening it decides
 * nothing. Deciding needs an authenticated owner, or a signed surface reply (ADR 0021, ADR 0022, ADR 0025).
 */
export function approvalLink(approvalId: string): string {
  return `${config.APP_BASE_URL.replace(/\/+$/, "")}/app/approvals/${encodeURIComponent(approvalId)}`;
}

/**
 * A plain link to a customer order's page in the app. Like approvalLink it carries no token and no query string, and
 * opening it decides nothing (ADR 0027). The customer's note and external reference are never part of the link.
 */
export function customerOrderLink(orderId: string): string {
  return `${config.APP_BASE_URL.replace(/\/+$/, "")}/app/customer-orders/${encodeURIComponent(orderId)}`;
}
