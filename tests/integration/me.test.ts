import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { revokeSession } from "../../src/accounts/sessions.js";
import { createPrivyVerifier } from "../../src/accounts/privy.js";
import { ROUTES } from "../../src/api/registry.js";
import { MeSchema } from "../../src/api/schemas.js";

/**
 * GET /api/me over real HTTP and PostgreSQL (ADR 0058). Four identities are checked: an owner workspace token, a staff
 * workspace token, and an owner and a staff account session (a Privy sign-in, then POST /api/auth/session, as in
 * tests/integration/accounts.test.ts). Privy tokens are signed with a generated ES256 key and checked by the real verifier.
 */

const run = Date.now();
const APP = "app_me_test";
const WS = `ws-me-token-${run}`;
const WS_ACCOUNT = `ws-me-account-${run}`;
const WS_OTHER = `ws-me-other-${run}`;
const all = [WS, WS_ACCOUNT, WS_OTHER];
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verifier = createPrivyVerifier({ appId: APP, verificationKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() });

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const sessionIdOf = async (token: string): Promise<string> => {
  const row = (await query(`SELECT id FROM account_sessions WHERE token_hash = $1;`, [sha256(token)])).rows[0];
  if (!row) throw new Error("no session row for this token");
  return String(row.id);
};

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function privyToken(userId: string): string {
  const head = b64({ alg: "ES256", typ: "JWT" });
  const body = b64({ sub: userId, aud: APP, iss: "privy.io", exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${head}.${body}.${sig}`;
}

/** Any field that would reveal a credential: workspace tokens, account sessions, token ids and session ids. */
const SECRET_SHAPE = /bnd_|bns_|tok_|ses_/;
const EXACT_KEYS = ["agentsPaused", "credential", "label", "role", "workspaceId", "workspaceName"];

const alice = `did:privy:me-alice-${run}`;
const bob = `did:privy:me-bob-${run}`;

describe("GET /api/me: who the bearer token is (ADR 0058)", () => {
  const app = createApp({ rateLimits: { enabled: false }, accounts: { verifier } });
  let server: Server;
  let baseUrl = "";

  let owner: { id: string; token: string };
  let staff: { id: string; token: string };
  let ownerSession: string;
  let staffSession: string;
  let ownerSessionId: string;

  async function get(token?: string) {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}/api/me`, { headers });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, text, body, headers: res.headers };
  }

  async function call(method: string, route: string, opts: { bearer?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = {};
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl}${route}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, body, text };
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(WS, "Me Kitchen", "kitchen-v1");
    await provisionWorkspace(WS_OTHER, "Other Kitchen", "kitchen-v1");
    owner = await issueToken(WS, "owner", "founder-me");
    staff = await issueToken(WS, "staff", "line-cook-me");
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        baseUrl = addr && typeof addr === "object" ? `http://127.0.0.1:${addr.port}` : "";
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [all]);
    await query(`DELETE FROM accounts WHERE privy_user_id LIKE $1;`, [`did:privy:me-%-${run}`]);
    for (const id of all) await fsp.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
    await closePool();
  });

  it("an owner workspace token gets the owner's identity, with the token's label and the workspace token credential", async () => {
    const r = await get(owner.token);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      workspaceId: WS,
      workspaceName: "Me Kitchen",
      role: "owner",
      label: "founder-me",
      credential: "workspace_token",
      agentsPaused: false,
    });
    expect(Object.keys(r.body).sort()).toEqual(EXACT_KEYS);
  });

  it("a staff workspace token gets the staff role and its own label", async () => {
    const r = await get(staff.token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ workspaceId: WS, role: "staff", label: "line-cook-me", credential: "workspace_token" });
  });

  it("an owner account session is identified as an account session, in its workspace, with the account's label", async () => {
    await call("POST", "/api/account/workspaces", { bearer: privyToken(alice), body: { id: WS_ACCOUNT, name: "Account Kitchen", templateId: "kitchen-v1" } });
    const session = await call("POST", "/api/auth/session", { bearer: privyToken(alice), body: { workspaceId: WS_ACCOUNT } });
    expect(session.status).toBe(201);
    ownerSession = session.body.sessionToken;
    ownerSessionId = await sessionIdOf(ownerSession);
    const account = (await query(`SELECT id FROM accounts WHERE privy_user_id = $1;`, [alice])).rows[0];
    const r = await get(ownerSession);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      workspaceId: WS_ACCOUNT,
      workspaceName: "Account Kitchen",
      role: "owner",
      label: `member-${String(account.id).slice(-6)}`,
      credential: "account_session",
      agentsPaused: false,
    });
  });

  it("a staff account session (an invitation accepted by a second account) is identified as staff", async () => {
    const invite = await call("POST", `/api/workspaces/${WS_ACCOUNT}/invites`, { bearer: ownerSession, body: { label: "Bob, line cook" } });
    expect(invite.status).toBe(201);
    const joined = await call("POST", "/api/account/invites/accept", { bearer: privyToken(bob), body: { code: invite.body.code } });
    expect(joined.status).toBe(200);
    const session = await call("POST", "/api/auth/session", { bearer: privyToken(bob), body: { workspaceId: WS_ACCOUNT } });
    expect(session.status).toBe(201);
    staffSession = session.body.sessionToken;
    const r = await get(staffSession);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ workspaceId: WS_ACCOUNT, role: "staff", credential: "account_session" });
  });

  it("no token, a malformed token and an unknown token all get the same 401 as the other routes", async () => {
    const bodies = [];
    for (const token of [undefined, "nonsense", `bnd_${"B".repeat(43)}`, `bns_${"C".repeat(43)}`]) {
      const r = await get(token);
      expect(r.status, String(token)).toBe(401);
      bodies.push(r.body);
    }
    for (const body of bodies) expect(body).toMatchObject({ error: "Authentication required" });
  });

  it("a revoked workspace token gets 401 at once", async () => {
    const revoked = await issueToken(WS, "staff", "to-revoke-me");
    expect((await get(revoked.token)).status).toBe(200);
    const del = await call("DELETE", `/api/workspaces/${WS}/tokens/${revoked.id}`, { bearer: owner.token });
    expect(del.status).toBe(200);
    const r = await get(revoked.token);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: "Authentication required" });
  });

  it("a revoked account session gets 401 at once", async () => {
    const extra = await call("POST", "/api/auth/session", { bearer: privyToken(alice), body: { workspaceId: WS_ACCOUNT } });
    expect(extra.status).toBe(201);
    expect((await get(extra.body.sessionToken)).status).toBe(200);
    expect(await revokeSession(await sessionIdOf(extra.body.sessionToken))).toBe(true);
    const r = await get(extra.body.sessionToken);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: "Authentication required" });
  });

  it("an expired account session gets 401 at once", async () => {
    const extra = await call("POST", "/api/auth/session", { bearer: privyToken(alice), body: { workspaceId: WS_ACCOUNT } });
    expect(extra.status).toBe(201);
    expect((await get(extra.body.sessionToken)).status).toBe(200);
    await query(`UPDATE account_sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1;`, [await sessionIdOf(extra.body.sessionToken)]);
    const r = await get(extra.body.sessionToken);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: "Authentication required" });
  });

  it("the answer is the token's own workspace only, never another tenant's", async () => {
    const other = await issueToken(WS_OTHER, "owner", "other-founder");
    const r = await get(other.token);
    expect(r.body).toMatchObject({ workspaceId: WS_OTHER, workspaceName: "Other Kitchen", label: "other-founder" });
    expect((await get(owner.token)).body.workspaceId).toBe(WS);
  });

  it("no answer contains a token, session, hash or token id", async () => {
    const tokens = [owner.token, staff.token, ownerSession, staffSession];
    for (const token of tokens) {
      const r = await get(token);
      expect(r.status).toBe(200);
      expect(r.text).not.toMatch(SECRET_SHAPE);
      expect(r.text).not.toContain(token);
      expect(r.text).not.toContain(owner.id);
      expect(r.text).not.toContain(staff.id);
      expect(r.text).not.toContain(ownerSessionId);
    }
  });

  it("agentsPaused follows PUT /api/workspaces/:id/agents-paused, for every role", async () => {
    expect((await get(owner.token)).body.agentsPaused).toBe(false);
    const paused = await call("PUT", `/api/workspaces/${WS}/agents-paused`, { bearer: owner.token, body: { paused: true } });
    expect(paused.status).toBe(200);
    expect((await get(owner.token)).body.agentsPaused).toBe(true);
    expect((await get(staff.token)).body.agentsPaused).toBe(true);
    const resumed = await call("PUT", `/api/workspaces/${WS}/agents-paused`, { bearer: owner.token, body: { paused: false } });
    expect(resumed.status).toBe(200);
    expect((await get(staff.token)).body.agentsPaused).toBe(false);
  });

  it("answers with Cache-Control: no-store and a body the registry schema accepts", async () => {
    const r = await get(owner.token);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(MeSchema.safeParse(r.body).success).toBe(true);
    const spec = ROUTES.find((route) => route.operationId === "getMe");
    expect(spec?.responses[200]?.schema?.safeParse(r.body).success).toBe(true);
    expect(spec?.contractTested).toBe(true);
  });

  it("the schema is passthrough like the others: an additive field is accepted, a wrong type is not", () => {
    const base = { workspaceId: "w", workspaceName: "n", role: "owner", label: "l", credential: "workspace_token", agentsPaused: false };
    expect(MeSchema.safeParse(base).success).toBe(true);
    expect(MeSchema.safeParse({ ...base, futureField: "ok" }).success).toBe(true);
    expect(MeSchema.safeParse({ ...base, role: "admin" }).success).toBe(false);
  });
});
