import { config } from "../config/env.js";

/**
 * A plain link to the approval page in the app. It carries no token and no query string, and opening it decides
 * nothing. Deciding needs an authenticated owner, or a signed surface reply (ADR 0021, ADR 0022, ADR 0025).
 */
export function approvalLink(approvalId: string): string {
  return `${config.APP_BASE_URL.replace(/\/+$/, "")}/app/approvals/${encodeURIComponent(approvalId)}`;
}
