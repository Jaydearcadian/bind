/**
 * Post analytics: the provider boundary (docs/decisions/0091).
 *
 * A provider supplies post numbers for one account. Its output is UNTRUSTED: a platform, a remote service or a fixture can
 * return anything. So the normalised type carries only ids, enums, numbers and timestamps. No caption, comment, bio or other
 * free text from the platform ever reaches this type, the database, a report, an audit row or an event. The validator in
 * ./validate.ts is the only way provider output becomes a ProviderPost.
 */

/** The formats a post can have. Anything the provider calls something else is `other`, never free text. */
export const MEDIA_TYPES = ["reel", "image", "carousel", "video", "story", "other"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export interface PostMetrics {
  reach: number;
  impressions: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  /** Plays, for formats that have them (reels and video). Absent otherwise. */
  plays?: number;
}

export interface ProviderPost {
  /** The provider's id for the post. Validated: letters, digits and `_ . : -`, at most 128 characters. */
  externalId: string;
  publishedAt: Date;
  mediaType: MediaType;
  metrics: PostMetrics;
  /** Reach from people who follow the account, and from people who do not. Both or neither. */
  followerReach?: number;
  nonFollowerReach?: number;
  /** Reach per ISO 3166-1 alpha-2 country code. Absent when the provider does not break reach down by country. */
  countryReach?: Record<string, number>;
}

export interface ProviderAccount {
  /** The provider's id for the account. Same rules as a post id. */
  externalId: string;
}

/** Which breakdowns a provider can supply. The analysis reports a breakdown as not supplied when its flag is false. */
export interface ProviderCapabilities {
  perPostReach: boolean;
  followerSplit: boolean;
  hourOfDay: boolean;
  country: boolean;
  mediaType: boolean;
}

export interface FetchPostsRequest {
  /** The provider's account id (ProviderAccount.externalId). */
  accountId: string;
  /** Inclusive start instant. */
  since: Date;
  /** Exclusive end instant. */
  until: Date;
  /** Aborted when the caller gives up (the sync's timeout). A provider should stop its request when it fires. */
  signal?: AbortSignal;
}

export interface PostAnalyticsProvider {
  readonly id: string;
  /** True for a provider that produces fabricated data. Every report and surface that uses it says so. */
  readonly isSimulated: boolean;
  readonly capabilities: ProviderCapabilities;
  listAccounts(): Promise<ProviderAccount[]>;
  fetchPosts(request: FetchPostsRequest): Promise<ProviderPost[]>;
}

/** The refusal code for a provider that is not available on this server. */
export const PROVIDER_NOT_AVAILABLE_CODE = "ANALYTICS_PROVIDER_NOT_AVAILABLE" as const;
/** The refusal code for provider output that fails validation. */
export const PROVIDER_OUTPUT_INVALID_CODE = "ANALYTICS_PROVIDER_OUTPUT_INVALID" as const;

/** Malformed provider output. The message names the field and the rule; it never repeats the value. */
export class AnalyticsProviderOutputError extends Error {
  readonly code = PROVIDER_OUTPUT_INVALID_CODE;

  constructor(reason: string) {
    super(`The analytics provider returned data that is not valid: ${reason}`);
    this.name = "AnalyticsProviderOutputError";
  }
}

/** A refusal the API maps to a status and a code. The message is fixed text written by this code, never provider text. */
export class AnalyticsError extends Error {
  readonly code: string;
  readonly status: number;
  /** Set when the caller should wait this long before asking again (sent as Retry-After). */
  readonly retryAfterSeconds?: number;

  constructor(code: string, status: number, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "AnalyticsError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
