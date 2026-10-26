import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildOpenApiDocument, serializeOpenApiDocument, API_VERSION, jsonSchema } from "../../src/api/openapi.js";
import { ROUTES } from "../../src/api/registry.js";

/** The OpenAPI document is generated from the route registry (docs/decisions/0034). These tests check its structure. */

const HTTP_METHODS = ["get", "post", "put", "delete", "patch"];
/** Access levels that carry no bearer token: the spec says they are described in the operation description instead. */
const NO_BEARER_ACCESS = new Set(["public", "metrics-token", "signed-webhook"]);

/** The express path with `:name` as the OpenAPI `{name}`. Written out here so the test does not reuse the builder. */
function openApiPath(expressPath: string): string {
  return expressPath.replace(/:(\w+)/g, "{$1}");
}

function operationsOf(doc: any): Array<{ path: string; method: string; op: any }> {
  const out: Array<{ path: string; method: string; op: any }> = [];
  for (const [p, item] of Object.entries<any>(doc.paths)) {
    for (const [method, op] of Object.entries<any>(item)) {
      if (HTTP_METHODS.includes(method)) out.push({ path: p, method, op });
    }
  }
  return out;
}

describe("OpenAPI document generated from the route registry", () => {
  const doc = buildOpenApiDocument(ROUTES, API_VERSION) as any;

  it("the document is valid openapi 3 structure", () => {
    expect(doc.openapi).toBe("3.0.3");
    expect(doc.info.title).toBe("Bind API");
    expect(doc.info.version).toBe(API_VERSION);
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    for (const p of Object.keys(doc.paths)) {
      expect(p.startsWith("/"), p).toBe(true);
    }
    for (const { path: p, method, op } of operationsOf(doc)) {
      const where = `${method.toUpperCase()} ${p}`;
      expect(typeof op.operationId, where).toBe("string");
      expect(op.operationId.length, where).toBeGreaterThan(0);
      expect(Array.isArray(op.security), `${where} has a security field`).toBe(true);
      expect(typeof op.responses, where).toBe("object");
      expect(Object.keys(op.responses).length, `${where} has a response`).toBeGreaterThan(0);
      for (const [status, response] of Object.entries<any>(op.responses)) {
        expect(typeof response.description, `${where} ${status} has a description`).toBe("string");
      }
    }
    const ids = operationsOf(doc).map(({ op }) => op.operationId);
    expect(new Set(ids).size, "operationIds are unique").toBe(ids.length);
  });

  it("path parameters in the url are declared", () => {
    for (const { path: p, method, op } of operationsOf(doc)) {
      const inUrl = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const declared = (op.parameters ?? [])
        .filter((param: any) => param.in === "path")
        .map((param: any) => param.name);
      expect(declared.sort(), `${method.toUpperCase()} ${p}`).toEqual([...inUrl].sort());
      for (const param of op.parameters ?? []) {
        if (param.in === "path") expect(param.required, `${p} ${param.name}`).toBe(true);
      }
    }
  });

  it("public routes have no security requirement and others require bearerAuth", () => {
    for (const route of ROUTES) {
      if (!route.path.startsWith("/")) continue;
      const where = `${route.method.toUpperCase()} ${route.path}`;
      const op = doc.paths[openApiPath(route.path)][route.method];
      expect(op, where).toBeDefined();
      if (NO_BEARER_ACCESS.has(route.access)) {
        expect(op.security, where).toEqual([]);
      } else {
        expect(op.security, where).toEqual([{ bearerAuth: [] }]);
      }
      expect(op["x-bind-access"], where).toBe(route.access);
    }
    // The two routes that are not bearer-authenticated say how they are authenticated.
    for (const route of ROUTES.filter((r) => r.access === "metrics-token" || r.access === "signed-webhook")) {
      const op = doc.paths[openApiPath(route.path)][route.method];
      expect(op.description, `${route.path} description`).toMatch(/Bearer|signature/);
    }
  });

  it("the generated document is deterministic", () => {
    const first = serializeOpenApiDocument(buildOpenApiDocument(ROUTES, API_VERSION));
    const second = serializeOpenApiDocument(buildOpenApiDocument(ROUTES, API_VERSION));
    const reversed = serializeOpenApiDocument(buildOpenApiDocument([...ROUTES].reverse(), API_VERSION));
    expect(second).toBe(first);
    expect(reversed).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
  });

  it("every body schema converts without error", () => {
    const withBody = ROUTES.filter((r) => r.body !== undefined);
    expect(withBody.length).toBeGreaterThan(0);
    for (const route of withBody) {
      // An optional body is documented by its object schema (requestBody.required says whether it is needed).
      const inner = route.body instanceof z.ZodOptional ? route.body.unwrap() : route.body!;
      const converted = jsonSchema(inner) as any;
      expect(typeof converted, `${route.method} ${route.path}`).toBe("object");
      // An object, or a union of objects (the webhook route takes a surface event or a standard event).
      const isObjectOrUnion = converted.type === "object" || Array.isArray(converted.anyOf) || Array.isArray(converted.oneOf);
      expect(isObjectOrUnion, `${route.method} ${route.path}`).toBe(true);
    }
  });

  it("the document lists every registry route except the UI catch-all", () => {
    const apiRoutes = ROUTES.filter((r) => r.path.startsWith("/"));
    expect(operationsOf(doc).length).toBe(apiRoutes.length);
    expect(ROUTES.filter((r) => !r.path.startsWith("/")).map((r) => r.path)).toEqual(["*"]);
  });

  it("API_VERSION is the package version", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
    expect(API_VERSION).toBe(pkg.version);
  });
});
