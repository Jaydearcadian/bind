import { config, emailBaseUrlAllowed } from "../config/env.js";
import { createResendTransport, type EmailTransport } from "../adapters/email/resend.js";
import type { NotificationPayload } from "../adapters/web2/types.js";
import type { OwnerNoticeKind } from "./dispatch.js";
import { isVerifiedOwnerAddress } from "./recipients.js";

/** The send was refused because the address is not a verified owner address of the workspace. Carries no address. */
export class EmailRecipientNotVerifiedError extends Error {
  constructor() {
    super("The email recipient is not a verified owner address");
    this.name = "EmailRecipientNotVerifiedError";
  }
}

/** The subject and body of an email, without its recipient. */
export interface EmailContent {
  subject: string;
  text: string;
}

/**
 * Owner email (ADR 0074). The content is plain text and short. It is built from fixed sentences and from first-party facts
 * (a supplier name and an amount), which are still treated as untrusted text. It never carries a customer's note or
 * reference, an approve or reject link, a token, or a verification code except in the verification mail itself.
 */

export const OWNER_NOTICE_SUBJECT = "Something is waiting for you in Bind";
export const VERIFICATION_SUBJECT = "Your Bind verification code";
/** The longest supplier name shown in an email. Longer text is cut, with an ellipsis. */
export const MAX_EMAIL_FIELD_LENGTH = 80;

const NOTICE_KINDS: readonly OwnerNoticeKind[] = ["approval", "order_held", "order_declined", "order_partially_available"];

/**
 * Control characters (C0, DEL, C1), line and paragraph separators, and the bidirectional controls, by code point. Each one
 * is replaced by a space, so two words never run together.
 */
function isUnsafeCodePoint(code: number): boolean {
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  if (code === 0x2028 || code === 0x2029) return true;
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/**
 * Makes one untrusted value safe for one line of an email: control characters, line and paragraph separators and bidi
 * controls become spaces, runs of white space collapse, the text is trimmed and cut to `max` characters (the ellipsis is
 * inside the limit). Returns null when nothing printable is left.
 */
export function sanitizeUntrustedText(value: unknown, max = MAX_EMAIL_FIELD_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const spaced = Array.from(value, (ch) => (isUnsafeCodePoint(ch.codePointAt(0) ?? 0) ? " " : ch)).join("");
  const cleaned = spaced.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 3))}...`;
}

/** A short form of an address for an audit row or a log: the first letter of each part, the rest starred. */
export function maskEmailAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local[0]}***@${domain[0] ?? ""}***${tld}`;
}

/**
 * An address: the local part may not start with a dot, contain two dots in a row, or end with one. Each domain label starts
 * and ends with a letter or digit. The top-level domain is letters only.
 */
const ADDRESS = /^(?!\.)(?!.*\.\.)[a-z0-9._%+-]{1,64}(?<!\.)@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/** Text that could be a link, an address, a domain, or a phone-like number (ADR 0074). Such a supplier name is not shown. */
const LOOKS_LIKE_LINK_OR_CONTACT = /@|:\/\/|www\.|\w\.[a-z]{2,}|\d{6,}/i;

/** The longest owner address accepted. It is the surface binding's actor-id limit, so a binding can always be stored. */
export const MAX_OWNER_EMAIL_LENGTH = 120;

/** A lowercased, trimmed address that fits the rules, or null. Never throws. */
export function normaliseEmailAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const address = raw.trim().toLowerCase();
  if (address.length < 3 || address.length > MAX_OWNER_EMAIL_LENGTH) return null;
  return ADDRESS.test(address) ? address : null;
}

/** The app's base URL, without trailing slashes, when it may be used in an email. Throws otherwise. */
export function emailLinkBase(): string {
  const base = config.APP_BASE_URL;
  if (!emailBaseUrlAllowed(base, config.NODE_ENV)) {
    throw new Error("APP_BASE_URL must be https (or http on 127.0.0.1 or localhost outside production) to send email links");
  }
  return base.replace(/\/+$/, "");
}

/** Whether email is switched on for this server: a provider is configured. The API key is never read here. */
export function emailDeliveryOn(): boolean {
  return config.BIND_EMAIL_PROVIDER !== undefined;
}

/** The transport for the configured provider, built from the current configuration. Throws when none is configured. */
export function configuredEmailTransport(): EmailTransport {
  if (config.BIND_EMAIL_PROVIDER !== "resend" || !config.BIND_EMAIL_API_KEY || !config.BIND_EMAIL_FROM) {
    throw new Error("Email is not configured");
  }
  return createResendTransport({
    apiKey: config.BIND_EMAIL_API_KEY,
    from: config.BIND_EMAIL_FROM,
    apiBase: config.BIND_EMAIL_API_BASE,
  });
}

function amountText(cents: unknown): string | null {
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents < 0 || cents > 1e12) return null;
  return (cents / 100).toFixed(2);
}

/** The one plain sentence for each kind. Only an approval names anything: its supplier and its amount. */
function noticeSentence(kind: OwnerNoticeKind, metadata: Record<string, unknown>): string {
  switch (kind) {
    case "approval": {
      // A supplier name that could carry a link, an address, a domain or a long number is left out: a notice must not hand
      // a phisher a place to send people. The generic sentence is used instead.
      const named = sanitizeUntrustedText(metadata.supplierName);
      const supplier = named && !LOOKS_LIKE_LINK_OR_CONTACT.test(named) ? named : null;
      const amount = amountText(metadata.amountCents);
      if (supplier && amount) return `A purchase from ${supplier} for $${amount} USDC is waiting for your approval.`;
      if (supplier) return `A purchase from ${supplier} is waiting for your approval.`;
      return "A purchase is waiting for your approval.";
    }
    case "order_held":
      return "A customer order is waiting for your decision.";
    case "order_declined":
      return "A customer order was declined.";
    case "order_partially_available":
      return "A customer order can only be partly filled from stock.";
  }
}

/**
 * The owner notice email (ADR 0074). `kind` comes from the payload metadata that dispatch sets; an unknown kind is refused.
 * The link is the app's front page, not an approval or order link, so opening it decides nothing.
 */
export function buildOwnerNoticeEmail(input: { kind: unknown; metadata: Record<string, unknown>; baseUrl: string }): EmailContent {
  if (typeof input.kind !== "string" || !NOTICE_KINDS.includes(input.kind as OwnerNoticeKind)) {
    throw new Error("The email notice has no known kind");
  }
  const sentence = noticeSentence(input.kind as OwnerNoticeKind, input.metadata);
  const text = [
    sentence,
    "",
    `${input.baseUrl.replace(/\/+$/, "")}/app/`,
    "",
    "Open Bind to look at it and decide. Nothing happens until you do.",
    "",
  ].join("\n");
  return { subject: OWNER_NOTICE_SUBJECT, text };
}

/** The verification mail. The code is in it and nowhere else. */
export function buildVerificationEmail(input: { code: string; expiresMinutes: number }): EmailContent {
  if (!/^\d{6}$/.test(input.code)) throw new Error("A verification code is six digits");
  const text = [
    `Your Bind verification code is ${input.code}.`,
    "",
    `It expires in ${input.expiresMinutes} minutes. Enter it in Bind to confirm this address for owner notices.`,
    "",
    "If you did not ask for this, ignore this email. Nothing else changes.",
    "",
  ].join("\n");
  return { subject: VERIFICATION_SUBJECT, text };
}

/**
 * Sends one owner notice through the configured provider and returns the provider's id. Used by the notification emitter
 * for channel `email`. The recipient must be a valid address. Errors carry no address and no key.
 */
export async function sendOwnerNoticeEmail(payload: NotificationPayload): Promise<{ id: string }> {
  const to = normaliseEmailAddress(payload.recipient);
  if (!to) throw new Error("The email recipient is not an address");
  // Defence in depth (ADR 0074): an address that is not a live, verified owner address of this workspace is never sent to,
  // whatever the caller resolved. The caller audits the refusal.
  if (!(await isVerifiedOwnerAddress(payload.workspaceId, to))) throw new EmailRecipientNotVerifiedError();
  const message = buildOwnerNoticeEmail({
    kind: payload.metadata?.noticeKind,
    metadata: payload.metadata ?? {},
    baseUrl: emailLinkBase(),
  });
  return configuredEmailTransport().send({ ...message, to });
}
