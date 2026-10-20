import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/**
 * Checks the draft response and event specification (docs/ecosystem/RESPONSE_AND_EVENT_SPEC.md) without building any of it.
 * Every example is validated against its schema: each `.valid.` file must pass and each `.invalid.` file must fail. The error
 * catalogue and the event name table are checked against the source and docs/EVENTS.md. A spec that no test reads drifts.
 * (ajv is a devDependency; the MCP SDK already brings the same version.)
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SPEC = path.join(ROOT, "docs", "ecosystem", "spec");
const EXAMPLES = path.join(SPEC, "examples");
const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, "utf8"));

const ajv = new Ajv2020({ strict: true, allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const schemas = {
  "error-v2": readJson(path.join(SPEC, "error-v2.schema.json")),
  "response-meta-v1": readJson(path.join(SPEC, "response-meta-v1.schema.json")),
  "event-envelope-v1": readJson(path.join(SPEC, "event-envelope-v1.schema.json")),
};
const endpoint = readJson(path.join(SPEC, "webhook-endpoint.schema.json"));
const validators: Record<string, ReturnType<Ajv2020["compile"]>> = {
  "error-v2": ajv.compile(schemas["error-v2"]),
  "response-meta-v1": ajv.compile(schemas["response-meta-v1"]),
  "event-envelope-v1": ajv.compile(schemas["event-envelope-v1"]),
};
ajv.addSchema(endpoint);
validators["webhook-endpoint-create"] = ajv.getSchema(`${endpoint.$id}#/$defs/create`)!;
validators["webhook-endpoint"] = ajv.getSchema(`${endpoint.$id}#/$defs/endpoint`)!;
validators["webhook-delivery"] = ajv.getSchema(`${endpoint.$id}#/$defs/delivery`)!;

describe("draft schemas and examples", () => {
  const files = fs.readdirSync(EXAMPLES).filter((f) => /\.(valid|invalid)\./.test(f)).sort();

  it("has valid and invalid examples for every schema that takes a request or response", () => {
    for (const name of ["error-v2", "response-meta-v1", "event-envelope-v1", "webhook-endpoint-create"]) {
      expect(files.some((f) => f.startsWith(`${name}.valid.`)), `${name} valid`).toBe(true);
      expect(files.some((f) => f.startsWith(`${name}.invalid.`)), `${name} invalid`).toBe(true);
    }
  });

  for (const file of files) {
    const schemaName = file.slice(0, file.indexOf("."));
    const expectValid = file.includes(".valid.");
    it(`${file} is ${expectValid ? "accepted" : "rejected"} by ${schemaName}`, () => {
      const validate = validators[schemaName];
      expect(validate, `no validator for ${schemaName}`).toBeDefined();
      const ok = validate!(readJson(path.join(EXAMPLES, file)));
      expect(ok, JSON.stringify(validate!.errors)).toBe(expectValid);
    });
  }

  it("today's event envelope is not a v1 envelope: the migration adds fields and removes none", () => {
    const today = readJson(path.join(EXAMPLES, "event-envelope-today.json"));
    expect(validators["event-envelope-v1"]!(today)).toBe(false);
    const missing = (validators["event-envelope-v1"]!.errors ?? []).filter((e) => e.keyword === "required").map((e) => (e.params as { missingProperty: string }).missingProperty).sort();
    expect(missing).toEqual(["name", "schemaVersion", "workspaceId"]);
    const migrated = { ...today, name: "order.submitted", schemaVersion: 1, workspaceId: "ws-kitchen-1", id: "459940.3293" };
    expect(validators["event-envelope-v1"]!(migrated), JSON.stringify(validators["event-envelope-v1"]!.errors)).toBe(true);
    for (const key of Object.keys(today)) expect(Object.keys(migrated)).toContain(key);
  });

  it("the v1 envelope keeps every required field of today's envelope", () => {
    const required: string[] = schemas["event-envelope-v1"].required;
    for (const key of ["id", "type", "at", "effectClass", "decision", "actor", "data"]) expect(required).toContain(key);
  });
});

describe("error catalogue", () => {
  const catalogue = readJson(path.join(SPEC, "error-catalogue.json")) as { codes: { code: string; httpStatus: number; category: string; retryable: boolean; existing: boolean }[] };
  const sourceText = (() => {
    const parts: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "ui") walk(full); } else if (entry.name.endsWith(".ts")) parts.push(fs.readFileSync(full, "utf8"));
      }
    };
    walk(path.join(ROOT, "src"));
    return parts.join("\n");
  })();

  it("lists each code once, in the error body's code format", () => {
    const codes = catalogue.codes.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it("every existing code is in the source, and no proposed code is yet (flip it when it ships)", () => {
    for (const c of catalogue.codes) {
      const present = sourceText.includes(`"${c.code}"`);
      expect(present, `${c.code} existing=${c.existing}`).toBe(c.existing);
    }
  });

  it("category, status and retryability agree", () => {
    const expected: Record<string, number[]> = { validation: [400, 413, 422], authentication: [401], authorization: [403], not_found: [404], conflict: [409], policy: [403, 409, 422], rate_limited: [429], upstream: [502, 504], unavailable: [503], internal: [500] };
    for (const c of catalogue.codes) {
      expect(expected[c.category], c.code).toContain(c.httpStatus);
      if (["validation", "authentication", "authorization", "not_found", "policy"].includes(c.category)) expect(c.retryable, c.code).toBe(false);
      if (c.category === "rate_limited") expect(c.retryable, c.code).toBe(true);
    }
  });
});

describe("event names", () => {
  const names = readJson(path.join(SPEC, "event-names.json")) as { events: { type: string; name: string; object: string; visibility: string; renamed: boolean }[] };
  const doc = fs.readFileSync(path.join(ROOT, "docs", "EVENTS.md"), "utf8");
  const documented = (() => {
    const section = doc.slice(doc.indexOf("## Event types"));
    const types: string[] = [];
    for (const line of section.split("\n")) {
      if (!line.startsWith("|") || line.startsWith("|---") || line.startsWith("| Type")) continue;
      for (const m of (line.split("|")[1] ?? "").matchAll(/`([a-z_.]+)`/g)) types.push(m[1] as string);
    }
    return types;
  })();

  it("covers every event type documented in docs/EVENTS.md, and nothing else", () => {
    expect(names.events.map((e) => e.type).sort()).toEqual([...documented].sort());
  });

  it("gives each event a unique name that fits the envelope's name pattern", () => {
    const pattern = schemas["event-envelope-v1"].properties.name.pattern as string;
    const re = new RegExp(pattern);
    const seen = new Set<string>();
    for (const e of names.events) {
      expect(e.name, e.type).toMatch(re);
      expect(seen.has(e.name), `duplicate name ${e.name}`).toBe(false);
      seen.add(e.name);
      expect(e.renamed, e.type).toBe(e.type !== e.name);
    }
  });

  it("marks the same owner-only events as docs/EVENTS.md says staff never receive", () => {
    for (const e of names.events) {
      const ownerOnly = /^(auth|connector|kitchen_capacity)\./.test(e.type);
      expect(e.visibility, e.type).toBe(ownerOnly ? "owner" : "member");
    }
  });
});
