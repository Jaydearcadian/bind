/**
 * The Bind API client (docs/decisions/0036). Dependency-free: it runs in Node 22 and in browsers, and it imports nothing from
 * the server. The token is supplied by the caller; the SDK never reads it from the environment.
 */
export { BindClient, OwnerOperations, OPERATIONS } from "./client.js";
export type { BindClientOptions, CallOptions, BodyOf, SuccessOf, OperationId } from "./client.js";
export type { BindEvent, EventStreamOptions } from "./events.js";
export { BindError, BindApiError, BindNetworkError, BindTimeoutError, BindStreamError } from "./errors.js";
export type { BindApiErrorInit } from "./errors.js";
