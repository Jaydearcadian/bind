import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ESLint } from "eslint";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { config } from "../../src/config/env.js";
import { CredentialDecryptError, CredentialStoreDisabledError } from "../../src/credentials/crypto.js";
import {
  getCredentialForAdapter,
  listConnectors,
  revokeCredential,
  rotateCredentialKeys,
  setCredential,
  verifyCredential,
} from "../../src/credentials/store.js";
import { clearVerifiers, registerVerifier } from "../../src/credentials/verifiers.js";

/*
 * Connector credentials (ADR 0024). HTTP against createApp() and direct store calls, against the real database.
 * The seeded secret is never allowed to appear in a stored row, an audit row, an effect row, an error body, a response
 * body or console output.
 */

const run = Date.now();
const wsA = `ws-cred-a-${run}`;
const wsB = `ws-cred-b-${run}`;
const allWorkspaceIds = [wsA, wsB];
const ACTOR = { type: "owner" as const, id: "alice" };
const CONNECTOR_KINDS_OK = "supplier";

const AUTH_REQUIRED = { error: "Authentication required" };
const OWNER_REQUIRED = { error: "Owner role required" };
const NOT_FOUND = { error: "Workspace not found" };
const NOT_CONFIGURED = { error: "Credential store is not configured" };

let counter = 0;
/** A connector id that is unique to this run and matches the connector id rule (lowercase, starts with a letter). */
function connId(tag: string): string {
  counter += 1;
  return `${tag}-${run}-${counter}`;
}

/** A secret that is easy to search for and never reused. */
function seeded(): string {
  return `SEEDED-SECRET-${randomBytes(12).toString("hex")}`;
}

function bufferHas(haystack: Buffer | null, needle: string): boolean {
  return haystack !== null && haystack.includes(Buffer.from(needle, "utf8"));
}

function sha8(key: string): string {
  return createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 8);
}

describe("Connector credentials: encrypted at rest, owner-only, honest status (ADR 0024)", () => {
  const app = createApp();
  let server: Server;
  let baseUrl = "";
  let ownerA: { id: string; token: string; label: string };
  let staffA: { id: string; token: string };
  let ownerB: { id: string; token: string };

  type CallOptions = { token?: string; body?: unknown };
  async function call(method: string, routePath: string, opts: CallOptions = {}) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, text, body };
  }

  const connectorPath = (ws: string, conn: string) => `/api/workspaces/${ws}/connectors/${conn}`;

  async function row(ws: string, conn: string) {
    return (
      await query(
        `SELECT id, workspace_id, connector_id, kind, ciphertext, nonce, auth_tag, key_id, fingerprint, status,
                last_verified_at, revoked_at
         FROM connector_credentials WHERE workspace_id = $1 AND connector_id = $2;`,
        [ws, conn]
      )
    ).rows[0];
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsA, "Credentials Kitchen A", "kitchen-v1");
    await provisionWorkspace(wsB, "Credentials Kitchen B", "kitchen-v1");
    ownerA = await issueToken(wsA, "owner", "alice");
    staffA = await issueToken(wsA, "staff", "line-cook");
    ownerB = await issueToken(wsB, "owner", "bob");
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(() => {
    clearVerifiers();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    clearVerifiers();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [allWorkspaceIds]);
    for (const id of allWorkspaceIds) {
      await fs.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
    }
    await closePool();
  });

  it("the stored value is not the plaintext secret", async () => {
    const conn = connId("stored");
    const secret = seeded();
    await setCredential({ workspaceId: wsA, connectorId: conn, kind: CONNECTOR_KINDS_OK, secret, actor: ACTOR });

    const stored = await query(
      `SELECT position(convert_to($2, 'UTF8') in ciphertext) AS in_ciphertext,
              position(convert_to($2, 'UTF8') in nonce) AS in_nonce,
              position(convert_to($2, 'UTF8') in auth_tag) AS in_tag,
              octet_length(nonce) AS nonce_len, octet_length(auth_tag) AS tag_len,
              octet_length(ciphertext) AS ct_len, key_id, fingerprint
       FROM connector_credentials WHERE workspace_id = $1 AND connector_id = $3;`,
      [wsA, secret, conn]
    );
    const s = stored.rows[0];
    expect(s.in_ciphertext).toBe(0);
    expect(s.in_nonce).toBe(0);
    expect(s.in_tag).toBe(0);
    expect(s.nonce_len).toBe(12);
    expect(s.tag_len).toBe(16);
    expect(s.ct_len).toBe(Buffer.byteLength(secret, "utf8"));
    expect(s.key_id).toMatch(/^[0-9a-f]{8}$/);
    expect(s.fingerprint).toMatch(/^[0-9a-f]{12}$/);

    const dump = await query(`SELECT row_to_json(c)::text AS j FROM connector_credentials c WHERE c.connector_id = $1;`, [conn]);
    expect(dump.rows[0].j).not.toContain(secret);

    expect(await getCredentialForAdapter(wsA, conn)).toEqual({ secret, status: "configured_unverified" });
  });

  it("a secret set through the API is never returned by any route", async () => {
    const conn = connId("routes");
    const secret = seeded();
    registerVerifier(conn, async () => ({ ok: true }));
    const bodies: string[] = [];

    const put = await call("PUT", connectorPath(wsA, conn), { token: ownerA.token, body: { kind: CONNECTOR_KINDS_OK, secret } });
    expect(put.status).toBe(200);
    bodies.push(put.text);
    const list = await call("GET", `/api/workspaces/${wsA}/connectors`, { token: ownerA.token });
    expect(list.status).toBe(200);
    bodies.push(list.text);
    const verify = await call("POST", `${connectorPath(wsA, conn)}/verify`, { token: ownerA.token });
    expect(verify.status).toBe(200);
    expect(verify.body).toEqual({ connectorId: conn, status: "verified", verification: "VERIFIED" });
    bodies.push(verify.text);
    const del = await call("DELETE", connectorPath(wsA, conn), { token: ownerA.token });
    expect(del.status).toBe(200);
    expect(del.body.status).toBe("revoked");
    bodies.push(del.text);

    for (const text of bodies) expect(text).not.toContain(secret);
  });

  it("no audit row, effect row, error body or console output contains the secret", async () => {
    const conn = connId("leak");
    const secret = seeded();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );
    const bodies: string[] = [];
    const seen = async <T extends { text: string }>(p: Promise<T>): Promise<T> => {
      const res = await p;
      bodies.push(res.text);
      return res;
    };

    await seen(call("PUT", connectorPath(wsA, conn), { token: ownerA.token, body: { kind: CONNECTOR_KINDS_OK, secret } }));
    // Failing calls: staff, bad kind, empty secret, oversize secret, another workspace's owner, unknown connector.
    expect((await seen(call("PUT", connectorPath(wsA, conn), { token: staffA.token, body: { kind: CONNECTOR_KINDS_OK, secret } }))).status).toBe(403);
    expect((await seen(call("PUT", connectorPath(wsA, conn), { token: ownerA.token, body: { kind: "payments", secret } }))).status).toBe(400);
    expect((await seen(call("PUT", connectorPath(wsA, conn), { token: ownerA.token, body: { kind: CONNECTOR_KINDS_OK, secret: "" } }))).status).toBe(400);
    expect((await seen(call("PUT", connectorPath(wsA, conn), { token: ownerA.token, body: { kind: CONNECTOR_KINDS_OK, secret: secret + "x".repeat(8200) } }))).status).toBe(400);
    expect((await seen(call("PUT", connectorPath(wsA, conn), { token: ownerB.token, body: { kind: CONNECTOR_KINDS_OK, secret } }))).status).toBe(404);
    expect((await seen(call("DELETE", connectorPath(wsA, "missing-connector"), { token: ownerA.token }))).status).toBe(404);

    // A verifier that throws with the secret in its message.
    registerVerifier(conn, async (s) => {
      throw new Error(`upstream rejected ${s} via https://supplier.example.test/v1/KEY-QQ`);
    });
    const threw = await seen(call("POST", `${connectorPath(wsA, conn)}/verify`, { token: ownerA.token }));
    expect(threw.status).toBe(200);
    expect(threw.body).toEqual({ connectorId: conn, status: "configured_unverified", verification: "FAILED", code: "VERIFIER_THREW" });

    registerVerifier(conn, async () => ({ ok: false, code: "BAD_KEY" }));
    expect((await seen(call("POST", `${connectorPath(wsA, conn)}/verify`, { token: ownerA.token }))).body.code).toBe("BAD_KEY");

    // Replace, then revoke, then revoke again.
    await seen(call("PUT", connectorPath(wsA, conn), { token: ownerA.token, body: { kind: CONNECTOR_KINDS_OK, secret: `${secret}-rotated` } }));
    await seen(call("DELETE", connectorPath(wsA, conn), { token: ownerA.token }));
    await seen(call("DELETE", connectorPath(wsA, conn), { token: ownerA.token }));

    for (const text of bodies) expect(text).not.toContain(secret);

    const consoleText = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(consoleText).not.toContain(secret);

    const audit = await query(
      `SELECT COUNT(*)::int AS n FROM audit_logs
       WHERE position($1 in COALESCE(evidence::text, '')) > 0 OR position($1 in actor_id) > 0 OR position($1 in action) > 0;`,
      [secret]
    );
    expect(audit.rows[0].n).toBe(0);
    const effects = await query(
      `SELECT COUNT(*)::int AS n FROM effects
       WHERE position($1 in COALESCE(error_message, '')) > 0 OR position($1 in COALESCE(result::text, '')) > 0 OR position($1 in operation) > 0;`,
      [secret]
    );
    expect(effects.rows[0].n).toBe(0);
    const workflows = await query(
      `SELECT COUNT(*)::int AS n FROM workflows
       WHERE position($1 in COALESCE(error_message, '')) > 0 OR position($1 in context_data::text) > 0;`,
      [secret]
    );
    expect(workflows.rows[0].n).toBe(0);
    const credentials = await query(`SELECT COUNT(*)::int AS n FROM connector_credentials WHERE position($1 in row_to_json(connector_credentials)::text) > 0;`, [secret]);
    expect(credentials.rows[0].n).toBe(0);
  });

  it("status never reads verified without a successful verification", async () => {
    const conn = connId("status");
    await setCredential({ workspaceId: wsA, connectorId: conn, kind: CONNECTOR_KINDS_OK, secret: seeded(), actor: ACTOR });
    expect((await row(wsA, conn)).status).toBe("configured_unverified");

    // No verifier registered: nothing changes.
    expect(await verifyCredential(wsA, conn, ACTOR)).toEqual({
      connectorId: conn,
      status: "configured_unverified",
      verification: "NOT_AVAILABLE",
    });
    expect((await row(wsA, conn)).status).toBe("configured_unverified");
    expect((await row(wsA, conn)).last_verified_at).toBeNull();

    // A failing verifier leaves it unverified.
    registerVerifier(conn, async () => ({ ok: false, code: "NOPE" }));
    const failed = await verifyCredential(wsA, conn, ACTOR);
    expect(failed).toEqual({ connectorId: conn, status: "configured_unverified", verification: "FAILED", code: "NOPE" });
    expect((await row(wsA, conn)).status).toBe("configured_unverified");

    // A passing verifier is the only way to reach verified.
    registerVerifier(conn, async () => ({ ok: true }));
    expect(await verifyCredential(wsA, conn, ACTOR)).toEqual({ connectorId: conn, status: "verified", verification: "VERIFIED" });
    expect((await row(wsA, conn)).status).toBe("verified");
    expect((await row(wsA, conn)).last_verified_at).not.toBeNull();

    // A later failure does not leave a stale verified status behind.
    registerVerifier(conn, async () => {
      throw new Error("network down");
    });
    expect((await verifyCredential(wsA, conn, ACTOR)).status).toBe("configured_unverified");
    expect((await row(wsA, conn)).status).toBe("configured_unverified");

    // A verifier that returns something other than an explicit ok is a failure.
    registerVerifier(conn, (async () => undefined) as unknown as () => Promise<{ ok: true }>);
    expect(await verifyCredential(wsA, conn, ACTOR)).toMatchObject({ verification: "FAILED", status: "configured_unverified" });
  });

  it("replacing a credential makes the old one unusable", async () => {
    const conn = connId("replace");
    const first = seeded();
    const second = seeded();
    registerVerifier(conn, async () => ({ ok: true }));

    const original = await setCredential({ workspaceId: wsA, connectorId: conn, kind: CONNECTOR_KINDS_OK, secret: first, actor: ACTOR });
    await verifyCredential(wsA, conn, ACTOR);
    const verifiedRow = await row(wsA, conn);
    expect(verifiedRow.status).toBe("verified");
    const oldFingerprint = original.fingerprint;

    const replaced = await setCredential({ workspaceId: wsA, connectorId: conn, kind: CONNECTOR_KINDS_OK, secret: second, actor: ACTOR });
    expect(replaced.status).toBe("configured_unverified");
    expect(replaced.lastVerifiedAt).toBeNull();
    expect(replaced.fingerprint).not.toBe(oldFingerprint);

    expect(await getCredentialForAdapter(wsA, conn)).toEqual({ secret: second, status: "configured_unverified" });
    const stale = await query(`SELECT COUNT(*)::int AS n FROM connector_credentials WHERE fingerprint = $1;`, [oldFingerprint]);
    expect(stale.rows[0].n).toBe(0);
    const current = await row(wsA, conn);
    expect(current.revoked_at).toBeNull();
    expect(bufferHas(current.ciphertext, first)).toBe(false);
  });

  it("revocation takes effect on the next call", async () => {
    const conn = connId("revoke");
    const secret = seeded();
    await setCredential({ workspaceId: wsA, connectorId: conn, kind: CONNECTOR_KINDS_OK, secret, actor: ACTOR });
    expect(await getCredentialForAdapter(wsA, conn)).toEqual({ secret, status: "configured_unverified" });

    const revoked = await revokeCredential(wsA, conn, ACTOR);
    expect(revoked).toMatchObject({ connectorId: conn, status: "revoked", fingerprint: null });
    expect(await getCredentialForAdapter(wsA, conn)).toBeNull();

    const destroyed = await row(wsA, conn);
    expect(destroyed.status).toBe("revoked");
    expect(destroyed.revoked_at).not.toBeNull();
    expect(destroyed.ciphertext).toBeNull();
    expect(destroyed.nonce).toBeNull();
    expect(destroyed.auth_tag).toBeNull();
    expect(destroyed.key_id).toBeNull();
    expect(destroyed.fingerprint).toBeNull();
  });

  it("a credential cannot be read across workspaces", async () => {
    const conn = connId("tenant");
    const secretA = seeded();
    const secretB = seeded();
    await setCredential({ workspaceId: wsA, connectorId: conn, kind: CONNECTOR_KINDS_OK, secret: secretA, actor: ACTOR });

    // Workspace B has no credential under this connector id.
    expect(await getCredentialForAdapter(wsB, conn)).toBeNull();

    // Workspace B has its own credential, then A's ciphertext is copied into B's row.
    await setCredential({ workspaceId: wsB, connectorId: conn, kind: CONNECTOR_KINDS_OK, secret: secretB, actor: { type: "owner", id: "bob" } });
    await query(
      `UPDATE connector_credentials AS b
       SET ciphertext = a.ciphertext, nonce = a.nonce, auth_tag = a.auth_tag, key_id = a.key_id
       FROM connector_credentials AS a
       WHERE a.workspace_id = $1 AND a.connector_id = $3 AND b.workspace_id = $2 AND b.connector_id = $3;`,
      [wsA, wsB, conn]
    );
    await expect(getCredentialForAdapter(wsB, conn)).rejects.toBeInstanceOf(CredentialDecryptError);
    expect(await getCredentialForAdapter(wsA, conn)).toEqual({ secret: secretA, status: "configured_unverified" });
    // The forged row is not a live credential: revoke it so later tests (rotation counts live rows) do not see it.
    await revokeCredential(wsB, conn, { type: "owner", id: "bob" });
  });

  it("staff cannot use the connector routes and another workspace's owner gets 404", async () => {
    const conn = connId("roles");
    const secret = seeded();
    const path = connectorPath(wsA, conn);

    const staffPut = await call("PUT", path, { token: staffA.token, body: { kind: CONNECTOR_KINDS_OK, secret } });
    expect(staffPut.status).toBe(403);
    expect(staffPut.body).toMatchObject(OWNER_REQUIRED);
    expect((await call("GET", `/api/workspaces/${wsA}/connectors`, { token: staffA.token })).status).toBe(403);
    expect((await call("DELETE", path, { token: staffA.token })).status).toBe(403);
    expect((await call("POST", `${path}/verify`, { token: staffA.token })).status).toBe(403);
    expect(await row(wsA, conn)).toBeUndefined();

    const crossPut = await call("PUT", path, { token: ownerB.token, body: { kind: CONNECTOR_KINDS_OK, secret } });
    expect(crossPut.status).toBe(404);
    expect(crossPut.body).toMatchObject(NOT_FOUND);
    expect((await call("GET", `/api/workspaces/${wsA}/connectors`, { token: ownerB.token })).body).toMatchObject(NOT_FOUND);
    expect((await call("DELETE", path, { token: ownerB.token })).body).toMatchObject(NOT_FOUND);
    expect((await call("POST", `${path}/verify`, { token: ownerB.token })).body).toMatchObject(NOT_FOUND);
    expect(await row(wsA, conn)).toBeUndefined();

    expect((await call("PUT", path, { body: { kind: CONNECTOR_KINDS_OK, secret } })).body).toMatchObject(AUTH_REQUIRED);
  });

  it("an invalid connector id, kind or empty secret is a 400 that does not echo the secret", async () => {
    const secret = seeded();
    const good = connId("valid");
    const cases: Array<{ conn: string; body: unknown }> = [
      { conn: "Bad Id!", body: { kind: CONNECTOR_KINDS_OK, secret } },
      { conn: "x", body: { kind: CONNECTOR_KINDS_OK, secret } },
      { conn: good, body: { kind: "payments", secret } },
      { conn: good, body: { kind: CONNECTOR_KINDS_OK, secret: "" } },
      { conn: good, body: { kind: CONNECTOR_KINDS_OK } },
      { conn: good, body: { kind: CONNECTOR_KINDS_OK, secret: 12345 } },
      { conn: good, body: { kind: CONNECTOR_KINDS_OK, secret: secret + "y".repeat(9000) } },
    ];
    for (const c of cases) {
      const res = await call("PUT", connectorPath(wsA, c.conn), { token: ownerA.token, body: c.body });
      expect(res.status, JSON.stringify(c)).toBe(400);
      expect(typeof res.body.error).toBe("string");
      expect(res.text).not.toContain(secret);
      expect(res.text).not.toContain(secret.slice(0, 20));
    }
    expect(await row(wsA, good)).toBeUndefined();
  });

  it("the routes answer 503 when no credential key is configured", async () => {
    const conn = connId("nokey");
    const saved = { current: config.BIND_CREDENTIAL_KEY, previous: config.BIND_CREDENTIAL_KEY_PREVIOUS };
    config.BIND_CREDENTIAL_KEY = undefined;
    config.BIND_CREDENTIAL_KEY_PREVIOUS = undefined;
    try {
      const put = await call("PUT", connectorPath(wsA, conn), { token: ownerA.token, body: { kind: CONNECTOR_KINDS_OK, secret: seeded() } });
      expect(put.status).toBe(503);
      expect(put.body).toMatchObject(NOT_CONFIGURED);
      expect((await call("GET", `/api/workspaces/${wsA}/connectors`, { token: ownerA.token })).body).toMatchObject(NOT_CONFIGURED);
      expect((await call("DELETE", connectorPath(wsA, conn), { token: ownerA.token })).body).toMatchObject(NOT_CONFIGURED);
      const verify = await call("POST", `${connectorPath(wsA, conn)}/verify`, { token: ownerA.token });
      expect(verify.status).toBe(503);
      expect(verify.body).toMatchObject(NOT_CONFIGURED);

      await expect(
        setCredential({ workspaceId: wsA, connectorId: conn, kind: CONNECTOR_KINDS_OK, secret: seeded(), actor: ACTOR })
      ).rejects.toBeInstanceOf(CredentialStoreDisabledError);
      await expect(listConnectors(wsA)).rejects.toBeInstanceOf(CredentialStoreDisabledError);
      await expect(getCredentialForAdapter(wsA, conn)).rejects.toBeInstanceOf(CredentialStoreDisabledError);
      expect(await row(wsA, conn)).toBeUndefined();
    } finally {
      config.BIND_CREDENTIAL_KEY = saved.current;
      config.BIND_CREDENTIAL_KEY_PREVIOUS = saved.previous;
    }
  });

  it("rotating the key re-encrypts every credential and the old key is no longer needed", async () => {
    const oldKey = config.BIND_CREDENTIAL_KEY!;
    const newKey = randomBytes(32).toString("base64");
    const connA = connId("rotate");
    const connB = connId("rotate");
    const secretA = seeded();
    const secretB = seeded();
    await setCredential({ workspaceId: wsA, connectorId: connA, kind: CONNECTOR_KINDS_OK, secret: secretA, actor: ACTOR });
    await setCredential({ workspaceId: wsB, connectorId: connB, kind: CONNECTOR_KINDS_OK, secret: secretB, actor: { type: "owner", id: "bob" } });
    const revokedConn = connId("rotate-revoked");
    await setCredential({ workspaceId: wsA, connectorId: revokedConn, kind: CONNECTOR_KINDS_OK, secret: seeded(), actor: ACTOR });
    await revokeCredential(wsA, revokedConn, ACTOR);

    const pending = (
      await query(
        `SELECT COUNT(*)::int AS n FROM connector_credentials WHERE status <> 'revoked' AND key_id <> $1 AND workspace_id = ANY($2::text[]);`,
        [sha8(newKey), allWorkspaceIds]
      )
    ).rows[0].n as number;
    expect(pending).toBeGreaterThanOrEqual(2);

    const saved = { current: config.BIND_CREDENTIAL_KEY, previous: config.BIND_CREDENTIAL_KEY_PREVIOUS };
    try {
      config.BIND_CREDENTIAL_KEY = newKey;
      config.BIND_CREDENTIAL_KEY_PREVIOUS = oldKey;

      const first = await rotateCredentialKeys({ workspaceId: allWorkspaceIds });
      expect(first).toEqual({ rotated: pending, skipped: 0, failed: 0 });
      const left = await query(
        `SELECT COUNT(*)::int AS n FROM connector_credentials WHERE status <> 'revoked' AND key_id <> $1 AND workspace_id = ANY($2::text[]);`,
        [sha8(newKey), allWorkspaceIds]
      );
      expect(left.rows[0].n).toBe(0);
      const revokedRow = await row(wsA, revokedConn);
      expect(revokedRow.ciphertext).toBeNull();

      const second = await rotateCredentialKeys({ workspaceId: allWorkspaceIds });
      expect(second.rotated).toBe(0);
      expect(second.failed).toBe(0);
      expect(second.skipped).toBeGreaterThanOrEqual(2);

      // The old key is no longer needed: the rotated rows decrypt with the new key alone.
      config.BIND_CREDENTIAL_KEY_PREVIOUS = undefined;
      expect(await getCredentialForAdapter(wsA, connA)).toEqual({ secret: secretA, status: "configured_unverified" });
      expect(await getCredentialForAdapter(wsB, connB)).toEqual({ secret: secretB, status: "configured_unverified" });
    } finally {
      config.BIND_CREDENTIAL_KEY = saved.current;
      config.BIND_CREDENTIAL_KEY_PREVIOUS = saved.previous;
    }
  });

  it("a row that cannot be decrypted is counted as failed and left unchanged", async () => {
    const oldKey = config.BIND_CREDENTIAL_KEY!;
    const newKey = randomBytes(32).toString("base64");
    const conn = connId("corrupt");
    await setCredential({ workspaceId: wsA, connectorId: conn, kind: CONNECTOR_KINDS_OK, secret: seeded(), actor: ACTOR });
    const before = await row(wsA, conn);
    const damaged = Buffer.from(before.ciphertext);
    damaged[0] ^= 0x01;
    await query(`UPDATE connector_credentials SET ciphertext = $3 WHERE workspace_id = $1 AND connector_id = $2;`, [wsA, conn, damaged]);

    const saved = { current: config.BIND_CREDENTIAL_KEY, previous: config.BIND_CREDENTIAL_KEY_PREVIOUS };
    try {
      config.BIND_CREDENTIAL_KEY = newKey;
      config.BIND_CREDENTIAL_KEY_PREVIOUS = oldKey;
      const result = await rotateCredentialKeys();
      expect(result.failed).toBeGreaterThanOrEqual(1);
      const after = await row(wsA, conn);
      expect(after.key_id).toBe(before.key_id);
      expect(after.ciphertext.equals(damaged)).toBe(true);
    } finally {
      config.BIND_CREDENTIAL_KEY = saved.current;
      config.BIND_CREDENTIAL_KEY_PREVIOUS = saved.previous;
    }
  });

  it("getCredentialForAdapter is not reachable from routes or tools", async () => {
    const agentFiles = (await fs.readdir(path.resolve(process.cwd(), "src/agents")))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join("src/agents", f));
    const files = ["src/server/app.ts", ...agentFiles];
    for (const file of files) {
      const text = await fs.readFile(path.resolve(process.cwd(), file), "utf8");
      expect(text, file).not.toContain("getCredentialForAdapter");
      expect(text, file).not.toMatch(/credentials\/store/);
    }

    // The lint rule must bite: a route or tool importing the store is an error, the admin module is not.
    const eslint = new ESLint({ cwd: process.cwd() });
    const lint = async (filePath: string, code: string) => {
      const [result] = await eslint.lintText(code, { filePath });
      return result.messages.filter((m) => m.ruleId === "no-restricted-imports");
    };
    const direct = `import { getCredentialForAdapter } from "../credentials/store.js";\nexport const x = getCredentialForAdapter;\n`;
    expect(await lint("src/server/probe-route.ts", direct)).toHaveLength(1);
    expect(await lint("src/agents/probe-tool.ts", direct)).toHaveLength(1);
    const viaAdmin = `import { setCredential } from "../credentials/admin.js";\nexport const x = setCredential;\n`;
    expect(await lint("src/server/probe-route.ts", viaAdmin)).toHaveLength(0);
    expect(await lint("src/credentials/probe-owner.ts", direct)).toHaveLength(0);
  });

  it("credential changes are audited under the owner token label", async () => {
    const conn = connId("audit");
    registerVerifier(conn, async () => ({ ok: true }));
    const path = connectorPath(wsA, conn);
    expect((await call("PUT", path, { token: ownerA.token, body: { kind: CONNECTOR_KINDS_OK, secret: seeded() } })).status).toBe(200);
    expect((await call("POST", `${path}/verify`, { token: ownerA.token })).status).toBe(200);
    expect((await call("DELETE", path, { token: ownerA.token })).status).toBe(200);

    const rows = (
      await query(
        `SELECT action, actor_type, actor_id, effect_class, evidence FROM audit_logs
         WHERE workspace_id = $1 AND evidence->>'connectorId' = $2 ORDER BY created_at ASC, id ASC;`,
        [wsA, conn]
      )
    ).rows;
    expect(rows.map((r) => r.action)).toEqual([
      "connector.credential_set",
      "connector.credential_verified",
      "connector.credential_revoked",
    ]);
    for (const r of rows) {
      expect(r.actor_type).toBe("owner");
      expect(r.actor_id).toBe(ownerA.label);
    }
    expect(rows[0].evidence).toMatchObject({ connectorId: conn, kind: CONNECTOR_KINDS_OK });
    expect(typeof rows[0].evidence.fingerprint).toBe("string");
    const other = await query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE actor_id = 'owner@bind.local' AND workspace_id = $1;`, [wsA]);
    expect(other.rows[0].n).toBe(0);
  });

  // Rotation scope (ADR 0040). These use their own workspaces, created here and deleted here.
  async function keyIdOf(workspaceId: string, connectorId: string): Promise<string> {
    const res = await query(`SELECT key_id FROM connector_credentials WHERE workspace_id = $1 AND connector_id = $2;`, [workspaceId, connectorId]);
    return res.rows[0].key_id as string;
  }

  it("rotation can be limited to one workspace", async () => {
    const isoA = `ws-cred-iso-a-${run}`;
    const isoB = `ws-cred-iso-b-${run}`;
    await provisionWorkspace(isoA, "Credential Isolation A", "kitchen-v1");
    await provisionWorkspace(isoB, "Credential Isolation B", "kitchen-v1");
    const oldKey = config.BIND_CREDENTIAL_KEY!;
    const newKey = randomBytes(32).toString("base64");
    const connA = connId("limit-a");
    const connB = connId("limit-b");
    await setCredential({ workspaceId: isoA, connectorId: connA, kind: CONNECTOR_KINDS_OK, secret: seeded(), actor: ACTOR });
    await setCredential({ workspaceId: isoB, connectorId: connB, kind: CONNECTOR_KINDS_OK, secret: seeded(), actor: ACTOR });

    const saved = { current: config.BIND_CREDENTIAL_KEY, previous: config.BIND_CREDENTIAL_KEY_PREVIOUS };
    try {
      config.BIND_CREDENTIAL_KEY = newKey;
      config.BIND_CREDENTIAL_KEY_PREVIOUS = oldKey;
      const limited = await rotateCredentialKeys({ workspaceId: isoA });
      expect(limited).toEqual({ rotated: 1, skipped: 0, failed: 0 });
      expect(await keyIdOf(isoA, connA)).toBe(sha8(newKey));
      // The other workspace is not touched by a rotation limited to isoA.
      expect(await keyIdOf(isoB, connB)).toBe(sha8(oldKey));
    } finally {
      config.BIND_CREDENTIAL_KEY = saved.current;
      config.BIND_CREDENTIAL_KEY_PREVIOUS = saved.previous;
      await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [[isoA, isoB]]);
    }
  });

  it("rotation without a filter still covers every workspace", async () => {
    const isoA = `ws-cred-all-a-${run}`;
    const isoB = `ws-cred-all-b-${run}`;
    await provisionWorkspace(isoA, "Credential Coverage A", "kitchen-v1");
    await provisionWorkspace(isoB, "Credential Coverage B", "kitchen-v1");
    const oldKey = config.BIND_CREDENTIAL_KEY!;
    const newKey = randomBytes(32).toString("base64");
    const connA = connId("all-a");
    const connB = connId("all-b");
    await setCredential({ workspaceId: isoA, connectorId: connA, kind: CONNECTOR_KINDS_OK, secret: seeded(), actor: ACTOR });
    await setCredential({ workspaceId: isoB, connectorId: connB, kind: CONNECTOR_KINDS_OK, secret: seeded(), actor: ACTOR });

    const saved = { current: config.BIND_CREDENTIAL_KEY, previous: config.BIND_CREDENTIAL_KEY_PREVIOUS };
    try {
      config.BIND_CREDENTIAL_KEY = newKey;
      config.BIND_CREDENTIAL_KEY_PREVIOUS = oldKey;
      // Other suites may leave rows that cannot be decrypted; only the counts for these two workspaces are asserted.
      const all = await rotateCredentialKeys();
      expect(all.rotated).toBeGreaterThanOrEqual(2);
      expect(await keyIdOf(isoA, connA)).toBe(sha8(newKey));
      expect(await keyIdOf(isoB, connB)).toBe(sha8(newKey));
    } finally {
      // Put every row back under the test key, so later tests in this file still decrypt the rows of other workspaces.
      config.BIND_CREDENTIAL_KEY = oldKey;
      config.BIND_CREDENTIAL_KEY_PREVIOUS = newKey;
      await rotateCredentialKeys();
      config.BIND_CREDENTIAL_KEY = saved.current;
      config.BIND_CREDENTIAL_KEY_PREVIOUS = saved.previous;
      await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [[isoA, isoB]]);
    }
  });
});
