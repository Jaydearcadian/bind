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
import { createPrivyVerifier } from "../../src/accounts/privy.js";
import { ROUTES } from "../../src/api/registry.js";

/**
 * Sign-in with Privy over real HTTP and PostgreSQL (ADR 0051). Privy tokens are signed with a generated ES256 key and checked
 * by the real verifier; only Privy's own key is not exercised (NOT_RUN until the owner's Privy app exists).
 */
const run = Date.now();
const APP = "app_accounts_test";
const wsOld = `ws-acct-old-${run}`;
const wsOther = `ws-acct-other-${run}`;
const wsNew = `ws-acct-new-${run}`;
const all = [wsOld, wsOther, wsNew];
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verifier = createPrivyVerifier({ appId: APP, verificationKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() });

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function privyToken(userId: string, extra: Record<string, unknown> = {}): string {
  const head = b64({ alg: "ES256", typ: "JWT" });
  const body = b64({ sub: userId, aud: APP, iss: "privy.io", exp: Math.floor(Date.now() / 1000) + 3600, ...extra });
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${head}.${body}.${sig}`;
}
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

function schemaFor(operationId: string, status: number) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  const schema = route?.responses[status]?.schema;
  if (!schema) throw new Error(`no schema for ${operationId} ${status}`);
  return schema;
}

describe("accounts, sessions, invitations and members", () => {
  const app = createApp({ rateLimits: { enabled: false }, accounts: { verifier } });
  const unconfigured = createApp({ rateLimits: { enabled: false }, accounts: { verifier: null } });
  let server: Server;
  let server2: Server;
  let baseUrl = "";
  let baseUrl2 = "";
  const alice = `did:privy:alice-${run}`;
  const bob = `did:privy:bob-${run}`;
  const carol = `did:privy:carol-${run}`;
  let oldOwner: { token: string };

  async function call(method: string, route: string, opts: { bearer?: string; body?: unknown; base?: string } = {}) {
    const headers: Record<string, string> = {};
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${opts.base ?? baseUrl}${route}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, body, text, headers: res.headers };
  }
  const session = async (userId: string, ws: string) => {
    const r = await call("POST", "/api/auth/session", { bearer: privyToken(userId), body: { workspaceId: ws } });
    return r;
  };

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsOld, "Old", "kitchen-v1");
    await provisionWorkspace(wsOther, "Other", "kitchen-v1");
    oldOwner = await issueToken(wsOld, "owner", "founder");
    const listen = (a: ReturnType<typeof createApp>) =>
      new Promise<{ s: Server; url: string }>((resolve) => {
        const s = a.listen(0, "127.0.0.1", () => {
          const addr = s.address();
          resolve({ s, url: addr && typeof addr === "object" ? `http://127.0.0.1:${addr.port}` : "" });
        });
      });
    const a = await listen(app);
    const b = await listen(unconfigured);
    server = a.s;
    baseUrl = a.url;
    server2 = b.s;
    baseUrl2 = b.url;
  });

  afterAll(async () => {
    for (const s of [server, server2]) if (s) await new Promise<void>((r) => s.close(() => r()));
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [all]);
    await query(`DELETE FROM accounts WHERE privy_user_id LIKE $1;`, [`did:privy:%-${run}`]);
    for (const id of all) await fsp.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
    await closePool();
  });

  it("answers 503 on the account routes when sign-in is not configured, and does not affect workspace tokens", async () => {
    const r = await call("GET", "/api/account/workspaces", { bearer: privyToken(alice), base: baseUrl2 });
    expect(r.status).toBe(503);
    const ok = await call("GET", `/api/workspaces/${wsOld}/members`, { bearer: oldOwner.token, base: baseUrl2 });
    expect(ok.status).toBe(200);
  });

  it("refuses a missing, bad, expired or workspace token with the same 401", async () => {
    const bodies: unknown[] = [];
    for (const bearer of [undefined, "nonsense", privyToken(alice, { exp: 1 }), privyToken(alice, { aud: "other" }), oldOwner.token]) {
      const r = await call("GET", "/api/account/workspaces", { bearer });
      expect(r.status).toBe(401);
      bodies.push({ error: r.body.error, code: r.body.code });
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("creates a workspace as an account, which becomes its owner, and lists it", async () => {
    const created = await call("POST", "/api/account/workspaces", { bearer: privyToken(alice), body: { id: wsNew, name: "New Place", templateId: "kitchen-v1" } });
    expect(created.status).toBe(201);
    expect(schemaFor("createAccountWorkspace", 201).safeParse(created.body).success).toBe(true);
    const dup = await call("POST", "/api/account/workspaces", { bearer: privyToken(bob), body: { id: wsNew, name: "Dup", templateId: "kitchen-v1" } });
    expect(dup.status).toBe(409);
    const listed = await call("GET", "/api/account/workspaces", { bearer: privyToken(alice) });
    expect(listed.body.map((w: any) => w.id)).toContain(wsNew);
    expect(listed.body.find((w: any) => w.id === wsNew).role).toBe("owner");
    for (const w of listed.body) expect((schemaFor("listAccountWorkspaces", 200) as unknown as { element: { safeParse: (v: unknown) => { success: boolean } } }).element.safeParse(w).success).toBe(true);
    const bobs = await call("GET", "/api/account/workspaces", { bearer: privyToken(bob) });
    expect(bobs.body).toEqual([]);
  });

  it("a session works like a workspace token for the owner, is scoped to its workspace, and is stored as a hash", async () => {
    const s = await session(alice, wsNew);
    expect(s.status).toBe(201);
    expect(s.headers.get("cache-control")).toBe("no-store");
    expect(schemaFor("createSession", 201).safeParse(s.body).success).toBe(true);
    expect(s.body.sessionToken).toMatch(/^bns_[A-Za-z0-9_-]{43}$/);
    const members = await call("GET", `/api/workspaces/${wsNew}/members`, { bearer: s.body.sessionToken });
    expect(members.status).toBe(200);
    const across = await call("GET", `/api/workspaces/${wsOld}/members`, { bearer: s.body.sessionToken });
    expect(across.status).toBe(404);
    const stored = await query(`SELECT token_hash FROM account_sessions WHERE token_hash = $1;`, [sha(s.body.sessionToken)]);
    expect(stored.rows).toHaveLength(1);
    const plaintext = await query(`SELECT 1 FROM account_sessions WHERE token_hash = $1;`, [s.body.sessionToken]);
    expect(plaintext.rows).toHaveLength(0);
  });

  it("refuses a session for a workspace the account does not belong to, with the answer a missing workspace gets", async () => {
    const notMember = await session(bob, wsNew);
    const missing = await session(bob, `ws-does-not-exist-${run}`);
    expect(notMember.status).toBe(404);
    expect(missing.status).toBe(404);
    expect({ ...notMember.body, requestId: 0 }).toEqual({ ...missing.body, requestId: 0 });
  });

  it("an invitation brings in staff: single use, staff cannot do owner things, the code is stored as a hash", async () => {
    const owner = (await session(alice, wsNew)).body.sessionToken as string;
    const made = await call("POST", `/api/workspaces/${wsNew}/invites`, { bearer: owner, body: { label: "Sam, line cook" } });
    expect(made.status).toBe(201);
    expect(schemaFor("createInvite", 201).safeParse(made.body).success).toBe(true);
    const code = made.body.code as string;
    expect((await query(`SELECT 1 FROM workspace_invites WHERE code_hash = $1;`, [code])).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM workspace_invites WHERE code_hash = $1;`, [sha(code)])).rows).toHaveLength(1);
    const list = await call("GET", `/api/workspaces/${wsNew}/invites`, { bearer: owner });
    expect(JSON.stringify(list.body)).not.toContain(code);

    const joined = await call("POST", "/api/account/invites/accept", { bearer: privyToken(bob), body: { code } });
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ id: wsNew, role: "staff" });
    const again = await call("POST", "/api/account/invites/accept", { bearer: privyToken(carol), body: { code } });
    expect(again.status).toBe(404);
    expect(again.body.code).toBe("INVITE_UNUSABLE");

    const staff = (await session(bob, wsNew)).body.sessionToken as string;
    expect((await call("GET", `/api/workspaces/${wsNew}/inventory`, { bearer: staff })).status).toBe(200);
    expect((await call("GET", `/api/workspaces/${wsNew}/members`, { bearer: staff })).status).toBe(403);
    expect((await call("POST", `/api/workspaces/${wsNew}/invites`, { bearer: staff, body: { label: "x" } })).status).toBe(403);
  });

  it("refuses unknown, malformed, revoked and expired codes with one answer, and does not consume a code for an existing member", async () => {
    const owner = (await session(alice, wsNew)).body.sessionToken as string;
    const make = async () => (await call("POST", `/api/workspaces/${wsNew}/invites`, { bearer: owner, body: { label: "t" } })).body;
    const revoked = await make();
    expect((await call("DELETE", `/api/workspaces/${wsNew}/invites/${revoked.id}`, { bearer: owner })).status).toBe(200);
    const expired = await make();
    await query(`UPDATE workspace_invites SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1;`, [expired.id]);
    const results = [];
    for (const code of ["bni_" + "A".repeat(43), "garbage", revoked.code, expired.code]) {
      const r = await call("POST", "/api/account/invites/accept", { bearer: privyToken(carol), body: { code } });
      expect(r.status).toBe(404);
      results.push(r.body.code);
    }
    expect(new Set(results)).toEqual(new Set(["INVITE_UNUSABLE"]));

    const live = await make();
    const member = await call("POST", "/api/account/invites/accept", { bearer: privyToken(alice), body: { code: live.code } });
    expect(member.status).toBe(409);
    expect(member.body.code).toBe("ALREADY_MEMBER");
    const stillUsable = await call("POST", "/api/account/invites/accept", { bearer: privyToken(carol), body: { code: live.code } });
    expect(stillUsable.status).toBe(200);
  });

  it("two people racing for one code: exactly one gets in", async () => {
    const owner = (await session(alice, wsNew)).body.sessionToken as string;
    const { code } = (await call("POST", `/api/workspaces/${wsNew}/invites`, { bearer: owner, body: { label: "race" } })).body;
    const racers = [1, 2, 3, 4].map((i) => call("POST", "/api/account/invites/accept", { bearer: privyToken(`did:privy:racer${i}-${run}`), body: { code } }));
    const results = await Promise.all(racers);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(3);
  });

  it("changing a role takes effect at once, the last owner is protected, and removing a member ends their session", async () => {
    const owner = (await session(alice, wsNew)).body.sessionToken as string;
    const bobSession = (await session(bob, wsNew)).body.sessionToken as string;
    const members = await call("GET", `/api/workspaces/${wsNew}/members`, { bearer: owner });
    for (const m of members.body) expect((schemaFor("listMembers", 200) as unknown as { element: { safeParse: (v: unknown) => { success: boolean } } }).element.safeParse(m).success).toBe(true);
    const aliceId = (await query(`SELECT id FROM accounts WHERE privy_user_id = $1;`, [alice])).rows[0].id;
    const bobId = (await query(`SELECT id FROM accounts WHERE privy_user_id = $1;`, [bob])).rows[0].id;

    // The only owner cannot be demoted or removed.
    const demote = await call("PUT", `/api/workspaces/${wsNew}/members/${aliceId}`, { bearer: owner, body: { role: "staff" } });
    expect(demote.status).toBe(409);
    expect(demote.body.code).toBe("LAST_OWNER");
    expect((await call("DELETE", `/api/workspaces/${wsNew}/members/${aliceId}`, { bearer: owner })).status).toBe(409);

    // Promote Bob: his existing session is an owner session straight away.
    const promoted = await call("PUT", `/api/workspaces/${wsNew}/members/${bobId}`, { bearer: owner, body: { role: "owner" } });
    expect(promoted.status).toBe(200);
    expect((await call("GET", `/api/workspaces/${wsNew}/members`, { bearer: bobSession })).status).toBe(200);
    // With two owners, Alice can be demoted; demote Bob back and remove him.
    expect((await call("PUT", `/api/workspaces/${wsNew}/members/${bobId}`, { bearer: owner, body: { role: "staff" } })).status).toBe(200);
    expect((await call("GET", `/api/workspaces/${wsNew}/members`, { bearer: bobSession })).status).toBe(403);
    const removed = await call("DELETE", `/api/workspaces/${wsNew}/members/${bobId}`, { bearer: owner });
    expect(removed.status).toBe(200);
    expect((await call("GET", `/api/workspaces/${wsNew}/inventory`, { bearer: bobSession })).status).toBe(401);
    expect((await session(bob, wsNew)).status).toBe(404);
    expect((await call("DELETE", `/api/workspaces/${wsNew}/members/${bobId}`, { bearer: owner })).status).toBe(404);
  });

  it("a workspace with an owner token and an owner member can drop either one, but not the last credential", async () => {
    await call("POST", "/api/account/workspaces", { bearer: privyToken(carol), body: { id: wsOther + "-x", name: "x", templateId: "kitchen-v1" } }).then(async (r) => {
      all.push(wsOther + "-x");
      expect(r.status).toBe(201);
    });
    const ws = wsOther + "-x";
    const token = await issueToken(ws, "owner", "old-owner");
    const carolId = (await query(`SELECT id FROM accounts WHERE privy_user_id = $1;`, [carol])).rows[0].id;
    const owner = (await session(carol, ws)).body.sessionToken as string;
    // The owner token can be revoked because the member is also an owner.
    const revoked = await call("DELETE", `/api/workspaces/${ws}/tokens/${token.id}`, { bearer: owner });
    expect(revoked.status).toBe(200);
    // Now the member is the only owner credential.
    expect((await call("DELETE", `/api/workspaces/${ws}/members/${carolId}`, { bearer: owner })).status).toBe(409);
  });

  it("a session never outlives its membership, even if the session row was not revoked", async () => {
    const owner = (await session(alice, wsNew)).body.sessionToken as string;
    const code = (await call("POST", `/api/workspaces/${wsNew}/invites`, { bearer: owner, body: { label: "tmp" } })).body.code as string;
    const dave = `did:privy:dave-${run}`;
    await call("POST", "/api/account/invites/accept", { bearer: privyToken(dave), body: { code } });
    const daveSession = (await session(dave, wsNew)).body.sessionToken as string;
    expect((await call("GET", `/api/workspaces/${wsNew}/inventory`, { bearer: daveSession })).status).toBe(200);
    await query(`UPDATE workspace_memberships SET removed_at = NOW() WHERE account_id = (SELECT id FROM accounts WHERE privy_user_id = $1) AND workspace_id = $2;`, [dave, wsNew]);
    expect((await call("GET", `/api/workspaces/${wsNew}/inventory`, { bearer: daveSession })).status).toBe(401);
  });

  it("sign-out ends the session; a workspace token cannot sign out; an expired session stops working", async () => {
    const s = (await session(alice, wsNew)).body.sessionToken as string;
    const notSession = await call("POST", "/api/auth/sign-out", { bearer: oldOwner.token });
    expect(notSession.body.signedOut).toBe(false);
    expect((await call("GET", `/api/workspaces/${wsOld}/members`, { bearer: oldOwner.token })).status).toBe(200); // still works
    const out = await call("POST", "/api/auth/sign-out", { bearer: s });
    expect(out.status).toBe(200);
    expect(out.body.signedOut).toBe(true);
    expect(schemaFor("signOut", 200).safeParse(out.body).success).toBe(true);
    expect((await call("GET", `/api/workspaces/${wsNew}/inventory`, { bearer: s })).status).toBe(401);

    const s2 = (await session(alice, wsNew)).body.sessionToken as string;
    await query(`UPDATE account_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE token_hash = $1;`, [sha(s2)]);
    expect((await call("GET", `/api/workspaces/${wsNew}/inventory`, { bearer: s2 })).status).toBe(401);
  });

  it("records joins, role changes, removals and invitations in the audit log, with ids only and for owners only", async () => {
    const rows = await query(`SELECT action, evidence FROM audit_logs WHERE workspace_id = $1 AND action LIKE 'auth.%' ORDER BY created_at ASC;`, [wsNew]);
    const actions = rows.rows.map((r) => r.action);
    for (const a of ["auth.member_joined", "auth.invite_created", "auth.invite_revoked", "auth.member_role_changed", "auth.member_removed"]) expect(actions).toContain(a);
    const text = JSON.stringify(rows.rows);
    expect(text).not.toContain("did:privy");
    expect(text).not.toMatch(/bni_[A-Za-z0-9_-]{43}/);
    expect(text).not.toMatch(/bns_[A-Za-z0-9_-]{43}/);
  });

  it("the old workspace-token flow is unchanged", async () => {
    const r = await call("GET", `/api/workspaces/${wsOld}/inventory`, { bearer: oldOwner.token });
    expect(r.status).toBe(200);
    const other = await call("GET", `/api/workspaces/${wsOther}/inventory`, { bearer: oldOwner.token });
    expect(other.status).toBe(404);
  });
});
