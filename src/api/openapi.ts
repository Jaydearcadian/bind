/**
 * Builds the OpenAPI 3.0.3 document from the route registry (docs/decisions/0034). Used by two callers, so they cannot
 * drift: `scripts/generate-openapi.ts` writes docs/openapi.json (npm run api:spec), and `GET /api/openapi.json` returns the
 * same document built at request time. The output is deterministic: object keys are sorted, and routes are sorted by path
 * and method by the object key order.
 */
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { ROUTES, type AccessLevel, type ResponseSpec, type RouteSpec } from "./registry.js";
import { ErrorBody, ResponseMetaSchema } from "./schemas.js";
import { IDEMPOTENT_ROUTES } from "../server/idempotency.js";

/**
 * The version in `info.version`. It must equal the version in package.json: tests/unit/openapi.test.ts checks it. It is a
 * constant, not a read of package.json, because the Vercel bundle does not guarantee that file is present at run time.
 */
export const API_VERSION = "0.1.0";

export const OPENAPI_VERSION = "3.0.3";

/** The access levels whose operations carry no bearer requirement (described in the operation text instead). */
const NO_BEARER: ReadonlySet<AccessLevel> = new Set<AccessLevel>(["public", "metrics-token", "signed-webhook"]);

const ACCESS_TEXT: Record<AccessLevel, string> = {
  public: "Access: public. No token is needed.",
  authenticated: "Access: any valid workspace token. The answer is scoped to the caller's own workspace.",
  member: "Access: a workspace token of the owner or a staff member of the workspace in the path.",
  owner: "Access: a workspace token of the owner of the workspace in the path. A staff token gets 403.",
  "owner-any":
    "Access: a workspace token of an owner. The service checks that the approval or order belongs to the caller's workspace; another workspace's id is answered as not found.",
  account:
    "Access: an account. Send a Privy access token (from signing in with Google or a wallet) as Authorization: Bearer. A workspace token is refused with 401. The route answers 503 when sign-in is not configured.",
  "metrics-token":
    "Access: not a workspace token. Send the operator's metrics token as Authorization: Bearer. A workspace token is refused with 401. The route is disabled (404) when no metrics token is configured.",
  "signed-webhook":
    "Access: not a bearer route. The body is authenticated by an HMAC-SHA256 over `timestamp + \".\" + raw body`, hex, in the x-bind-signature header, with the timestamp in x-bind-timestamp. A surface event uses the workspace's surface secret; a standard event uses the configured webhook secret. An unsigned or wrongly signed request is refused with 401 and processes nothing.",
};

/** Express `:name` segments as OpenAPI `{name}`. */
export function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:(\w+)/g, "{$1}");
}

/**
 * Converts a zod schema to JSON Schema (OpenAPI 3.0 dialect). Schemas are inlined, except the shared ErrorBody.
 * An optional schema is converted as its inner schema: presence is shown by `required`, not by an `anyOf` with `not`.
 * `removeAdditionalStrategy: "strict"` leaves `additionalProperties` open for a plain zod object, because the server
 * strips unknown fields rather than refusing them; only a `.strict()` object is documented as closed.
 */
function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  let inner: z.ZodTypeAny = schema;
  while (inner instanceof z.ZodOptional) inner = inner.unwrap();
  const converted = zodToJsonSchema(inner, {
    target: "openApi3",
    $refStrategy: "none",
    removeAdditionalStrategy: "strict",
  }) as Record<string, unknown>;
  delete converted.$schema;
  return converted;
}

function schemaOrRef(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema === ErrorBody) return { $ref: "#/components/schemas/ErrorBody" };
  return jsonSchema(schema);
}

function queryParameters(query: z.ZodTypeAny): Array<Record<string, unknown>> {
  const shape = (query as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape ?? {};
  return Object.entries(shape).map(([name, field]) => ({
    name,
    in: "query",
    required: !field.isOptional(),
    schema: jsonSchema(field),
  }));
}

function responsesOf(responses: Record<number, ResponseSpec>, withMeta = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const status of Object.keys(responses).map(Number).sort((a, b) => a - b)) {
    const response = responses[status];
    const entry: Record<string, unknown> = { description: response.description };
    if (response.schema) {
      const schema =
        withMeta && status >= 200 && status < 300 && response.schema instanceof z.ZodObject
          ? (response.schema as z.AnyZodObject).extend({ _meta: ResponseMetaSchema.optional() })
          : response.schema;
      const mime = response.contentType ?? "application/json";
      entry.content = {
        [mime]: { schema: mime === "application/json" ? schemaOrRef(schema) : { type: "string" } },
      };
    } else if (response.contentType) {
      entry.content = { [response.contentType]: { schema: { type: "string" } } };
    }
    out[String(status)] = entry;
  }
  return out;
}

function operationOf(route: RouteSpec): Record<string, unknown> {
  const pathParams = [...route.path.matchAll(/:(\w+)/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  const parameters: Record<string, unknown>[] = [...pathParams, ...(route.query ? queryParameters(route.query) : [])];
  if (IDEMPOTENT_ROUTES.has(`${route.method.toUpperCase()} ${route.path}`)) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: false,
      description:
        "1 to 128 characters from A-Z a-z 0-9 . _ : -. A retry with the same key and the same request returns the first outcome with Idempotent-Replayed: true; a different request is refused with 422 IDEMPOTENCY_KEY_REUSED; a retry while the first is running gets 409 IDEMPOTENCY_IN_PROGRESS. Stored for 24 hours.",
      schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
    });
  }
  const operation: Record<string, unknown> = {
    operationId: route.operationId,
    summary: route.summary,
    description: ACCESS_TEXT[route.access],
    tags: route.tags,
    security: NO_BEARER.has(route.access) ? [] : [{ bearerAuth: [] }],
    "x-bind-access": route.access,
    responses: responsesOf(route.responses, IDEMPOTENT_ROUTES.has(`${route.method.toUpperCase()} ${route.path}`)),
  };
  if (parameters.length > 0) operation.parameters = parameters;
  if (route.body) {
    operation.requestBody = {
      required: !route.body.isOptional(),
      content: { "application/json": { schema: schemaOrRef(route.body) } },
    };
  }
  return operation;
}

/** Sorts object keys at every depth. Arrays keep their order: their order is part of the meaning (for example `required`). */
export function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => sortKeysDeep(item)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
}

/**
 * The OpenAPI document for the routes. A route whose path is not an absolute path (the UI catch-all, `*`) is not an API
 * operation and is left out. Two entries for one method and path are an error.
 */
export function buildOpenApiDocument(routes: readonly RouteSpec[] = ROUTES, version: string = API_VERSION): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    if (!route.path.startsWith("/")) continue;
    const openApiPath = toOpenApiPath(route.path);
    paths[openApiPath] ??= {};
    if (paths[openApiPath][route.method] !== undefined) {
      throw new Error(`duplicate registry entry for ${route.method.toUpperCase()} ${route.path}`);
    }
    paths[openApiPath][route.method] = operationOf(route);
  }
  return sortKeysDeep({
    openapi: OPENAPI_VERSION,
    info: {
      title: "Bind API",
      version,
      description:
        "The Bind HTTP API. Generated from the route registry (src/api/registry.ts; docs/decisions/0034). Do not edit this file by hand: run npm run api:spec.",
    },
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "A workspace token (bnd_...) in Authorization: Bearer. Issued once; stored only as a hash.",
        },
      },
      schemas: {
        ErrorBody: jsonSchema(ErrorBody),
      },
    },
  }) as Record<string, unknown>;
}

/** The text written to docs/openapi.json: two-space indent and a final newline. */
export function serializeOpenApiDocument(doc: Record<string, unknown>): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
