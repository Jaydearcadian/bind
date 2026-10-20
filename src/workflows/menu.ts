import type pg from "pg";
import { query, withTransaction } from "../db/client.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { PolicyEngine } from "../policy/engine.js";
import { PolicyDecision } from "../policy/types.js";
import { newId } from "../utils/ids.js";
import type { AgentActor, OwnerActor } from "./fulfilment.js";

/**
 * Menu change proposals (Task 9, ADR 0028). An agent or a person proposes a change. Only an owner approves it, and only an
 * approved change is published. Publishing is an offer to customers, so it is a commercial commitment: an agent may publish
 * only when its role holds `menu.publish_change` (the kitchen's menu_feedback_agent does not). A proposal is immutable after
 * creation: a database trigger allows only its status and decision fields to change.
 */

export type MenuErrorCode =
  | "INVALID_INPUT"
  | "PROPOSAL_NOT_FOUND"
  | "ITEM_NOT_FOUND"
  | "NOT_PROPOSED"
  | "NOT_APPROVED"
  | "NOT_CANCELLABLE"
  | "NAME_TAKEN"
  | "ROLE_NOT_PERMITTED"
  | "AGENTS_PAUSED";

const ERROR_MESSAGES: Record<Exclude<MenuErrorCode, "INVALID_INPUT">, string> = {
  PROPOSAL_NOT_FOUND: "Menu proposal not found",
  ITEM_NOT_FOUND: "Menu item not found",
  NOT_PROPOSED: "Only a proposed change can be approved or rejected",
  NOT_APPROVED: "Only an approved change can be published",
  NOT_CANCELLABLE: "Only a proposed or approved change can be cancelled",
  NAME_TAKEN: "A menu item with this name already exists",
  ROLE_NOT_PERMITTED: "The agent role is not permitted to do this",
  AGENTS_PAUSED: "Agents are paused for this workspace",
};

/** A menu operation that cannot be done. The API maps the code to a status. Messages never echo a proposal's text. */
export class MenuError extends Error {
  readonly code: MenuErrorCode;

  constructor(code: MenuErrorCode, message?: string) {
    super(code === "INVALID_INPUT" ? message ?? "Invalid input" : ERROR_MESSAGES[code]);
    this.name = "MenuError";
    this.code = code;
  }
}

export type MenuChange =
  | { type: "add_item"; name: string; description?: string; priceCents: number }
  | { type: "update_price"; itemId: string; priceCents: number }
  | { type: "remove_item"; itemId: string };

export type MenuProposalStatus = "proposed" | "approved" | "rejected" | "published" | "cancelled";

export interface MenuProposalView {
  proposalId: string;
  status: MenuProposalStatus;
  change: MenuChange;
  /** Untrusted text from the proposer. Data only. */
  rationale: string | null;
  sourceFeedbackIds: string[];
  proposedBy: string;
  decidedBy: string | null;
  applied: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MenuItemView {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  available: boolean;
  updatedAt: Date;
}

export const MAX_NAME_CHARACTERS = 120;
export const MAX_DESCRIPTION_CHARACTERS = 500;
export const MAX_RATIONALE_CHARACTERS = 500;
export const MAX_PRICE_CENTS = 10_000_000;
export const MAX_SOURCE_FEEDBACK = 20;
const MAX_ID_CHARACTERS = 64;
const LIST_LIMIT = 100;
const MENU_LIMIT = 500;
/** The operations as named in the effect map (src/policy/effect-classifier.ts). A role's grant is checked for these names. */
const OP_PROPOSE = "menu.propose_change";
const OP_PUBLISH = "menu.publish_change";

const CONTROL_CHARACTER = /\p{Cc}/u;

function invalid(message: string): never {
  throw new MenuError("INVALID_INPUT", message);
}

function characterCount(text: string): number {
  return Array.from(text).length;
}

function checkName(value: unknown): string {
  if (typeof value !== "string") invalid("name must be text.");
  const name = value.trim();
  if (characterCount(name) < 1 || characterCount(name) > MAX_NAME_CHARACTERS) {
    invalid(`name must be 1 to ${MAX_NAME_CHARACTERS} characters.`);
  }
  if (CONTROL_CHARACTER.test(name)) invalid("name must not contain control characters.");
  return name;
}

/** Trimmed optional text with a length limit. Empty text is no text. */
function checkOptionalText(value: unknown, name: string, limit: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") invalid(`${name} must be text.`);
  const trimmed = value.trim();
  if (characterCount(trimmed) > limit) invalid(`${name} must be at most ${limit} characters.`);
  if (trimmed.includes("\u0000")) invalid(`${name} contains a character that cannot be stored.`);
  return trimmed.length === 0 ? null : trimmed;
}

function checkPrice(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_PRICE_CENTS) {
    invalid(`priceCents must be a whole number from 0 to ${MAX_PRICE_CENTS}.`);
  }
  return value;
}

function checkItemId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_ID_CHARACTERS) {
    invalid(`itemId must be 1 to ${MAX_ID_CHARACTERS} characters.`);
  }
  return value;
}

function checkChange(value: unknown): MenuChange {
  if (typeof value !== "object" || value === null) invalid("change must be an object.");
  const change = value as Record<string, unknown>;
  switch (change.type) {
    case "add_item": {
      const description = checkOptionalText(change.description, "description", MAX_DESCRIPTION_CHARACTERS);
      return {
        type: "add_item",
        name: checkName(change.name),
        ...(description !== null ? { description } : {}),
        priceCents: checkPrice(change.priceCents),
      };
    }
    case "update_price":
      return { type: "update_price", itemId: checkItemId(change.itemId), priceCents: checkPrice(change.priceCents) };
    case "remove_item":
      return { type: "remove_item", itemId: checkItemId(change.itemId) };
    default:
      return invalid("change type must be add_item, update_price or remove_item.");
  }
}

function checkSourceFeedbackIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SOURCE_FEEDBACK) {
    invalid(`sourceFeedbackIds must be a list of at most ${MAX_SOURCE_FEEDBACK} ids.`);
  }
  const ids = value.map((id: unknown) => {
    if (typeof id !== "string" || id.length < 1 || id.length > MAX_ID_CHARACTERS) {
      invalid(`each sourceFeedbackIds entry must be 1 to ${MAX_ID_CHARACTERS} characters.`);
    }
    return id;
  });
  return [...new Set(ids)];
}

function requireWorkspace(workspaceId: unknown): string {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) invalid("workspaceId is required.");
  return workspaceId;
}

function requireLabel(label: unknown): string {
  if (typeof label !== "string" || label.trim().length === 0) invalid("owner label is required.");
  return label.trim();
}

/** The actor's identity as stored: `agent:<role>` or `owner:<label>`. */
function identityOf(actor: AgentActor | OwnerActor): string {
  return actor.kind === "agent" ? `agent:${actor.roleName}` : `owner:${actor.label}`;
}

/** A role's grant for one operation, from its agent_roles row. A missing or disabled role holds no grant. */
async function requireGrant(client: pg.PoolClient, workspaceId: string, roleName: string, operation: string): Promise<void> {
  const res = await client.query(
    `SELECT id, workspace_id, role_name, permitted_effects, enabled FROM agent_roles WHERE workspace_id = $1 AND role_name = $2;`,
    [workspaceId, roleName]
  );
  const role = res.rows[0];
  if (!role) throw new MenuError("ROLE_NOT_PERMITTED");
  const decision = new PolicyEngine().evaluate({
    workspace: { workspaceId },
    role: {
      roleId: role.id,
      workspaceId: role.workspace_id,
      roleName: role.role_name,
      permittedEffects: role.permitted_effects,
      enabled: role.enabled,
    },
    operation,
  }).decision;
  if (decision !== PolicyDecision.ALLOW) throw new MenuError("ROLE_NOT_PERMITTED");
}

/**
 * Refuses an agent while the workspace is paused (ADR 0023). The row is locked shared, so a pause written while this
 * transaction runs waits for it, and cannot slip in between this check and the agent's change.
 */
async function requireNotPaused(client: pg.PoolClient, workspaceId: string): Promise<void> {
  const res = await client.query(`SELECT agents_paused FROM workspaces WHERE id = $1 FOR SHARE;`, [workspaceId]);
  if (res.rows[0]?.agents_paused === true) throw new MenuError("AGENTS_PAUSED");
}

async function writeAudit(
  client: pg.PoolClient,
  row: {
    workspaceId: string;
    actorType: "agent" | "owner";
    actorId: string;
    effectClass: EffectClass;
    action: string;
    decision: PolicyDecision;
    evidence: Record<string, unknown>;
  }
): Promise<void> {
  // Evidence holds ids, the change type and counts. It never holds a proposal's name, rationale or any feedback text.
  await client.query(
    `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8::jsonb, NOW());`,
    [newId("audit"), row.workspaceId, row.actorType, row.actorId, row.effectClass, row.action, row.decision, JSON.stringify(row.evidence)]
  );
}

/** Loads one proposal of the workspace and locks it. Another workspace's id is simply not found. */
async function lockProposal(client: pg.PoolClient, workspaceId: string, proposalId: string): Promise<any> {
  const res = await client.query(`SELECT * FROM menu_proposals WHERE id = $1 AND workspace_id = $2 FOR UPDATE;`, [
    proposalId,
    workspaceId,
  ]);
  if (res.rows.length === 0) throw new MenuError("PROPOSAL_NOT_FOUND");
  return res.rows[0];
}

async function requireItem(client: pg.PoolClient, workspaceId: string, itemId: string, lock: boolean): Promise<any> {
  const res = await client.query(
    `SELECT id, name, price_cents FROM menu_items WHERE id = $1 AND workspace_id = $2${lock ? " FOR UPDATE" : ""};`,
    [itemId, workspaceId]
  );
  if (res.rows.length === 0) throw new MenuError("ITEM_NOT_FOUND");
  return res.rows[0];
}

function toProposalView(row: any): MenuProposalView {
  return {
    proposalId: row.id,
    status: row.status,
    change: row.change,
    rationale: row.rationale ?? null,
    sourceFeedbackIds: row.source_feedback_ids ?? [],
    proposedBy: row.proposed_by,
    decidedBy: row.decided_by ?? null,
    applied: row.applied ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The operations whose refusals are audited (ADR 0023: a denied commitment is recorded as a denial). */
const PROPOSE_REFUSALS: readonly MenuErrorCode[] = ["ROLE_NOT_PERMITTED", "AGENTS_PAUSED"];
const PUBLISH_REFUSALS: readonly MenuErrorCode[] = ["ROLE_NOT_PERMITTED", "AGENTS_PAUSED", "NOT_APPROVED", "NAME_TAKEN", "ITEM_NOT_FOUND"];

interface RefusalAudit {
  workspaceId: string;
  action: "menu.propose_refused" | "menu.publish_refused";
  actorType: "agent" | "owner";
  actorId: string;
  effectClass: EffectClass;
  codes: readonly MenuErrorCode[];
  /** Present for a publish: the proposal id, recorded only when the proposal exists in this workspace. */
  proposalId?: string;
}

/**
 * Runs an operation and, if it refuses with one of the audited codes, writes the refusal in its own statement. The
 * transaction has rolled back by then, so the refusal row survives it. The row holds the code, and the proposal id only
 * when it is a proposal of this workspace. It never holds any text from the request.
 */
async function withRefusalAudit<T>(refusal: RefusalAudit, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof MenuError && refusal.codes.includes(err.code)) {
      const evidence: Record<string, unknown> = {};
      if (refusal.proposalId !== undefined) {
        const known = await query(`SELECT id FROM menu_proposals WHERE id = $1 AND workspace_id = $2;`, [
          refusal.proposalId,
          refusal.workspaceId,
        ]);
        evidence.proposalId = known.rows.length > 0 ? refusal.proposalId : null;
      }
      evidence.code = err.code;
      await query(
        `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, 'DENY', $7::jsonb, NOW());`,
        [newId("audit"), refusal.workspaceId, refusal.actorType, refusal.actorId, refusal.effectClass, refusal.action, JSON.stringify(evidence)]
      );
    }
    throw err;
  }
}

/**
 * Creates a proposal in status `proposed`. An agent must hold `menu.propose_change` and the workspace must not be paused;
 * an owner is not checked against the role and is not blocked by the pause. Every item and feedback id is checked against
 * this workspace only.
 */
export async function proposeMenuChange(
  input: { workspaceId: string; change: MenuChange; rationale?: string; sourceFeedbackIds?: string[] },
  actor: AgentActor | OwnerActor
): Promise<MenuProposalView> {
  const workspaceId = requireWorkspace(input.workspaceId);
  const change = checkChange(input.change);
  const rationale = checkOptionalText(input.rationale, "rationale", MAX_RATIONALE_CHARACTERS);
  const sourceIds = checkSourceFeedbackIds(input.sourceFeedbackIds);
  const proposedBy = identityOf(actor);
  const id = newId("mprop");

  const refusal: RefusalAudit = {
    workspaceId,
    action: "menu.propose_refused",
    actorType: actor.kind,
    actorId: proposedBy,
    effectClass: EffectClass.EXTERNAL_REQUEST,
    codes: PROPOSE_REFUSALS,
  };
  return withRefusalAudit(refusal, () => withTransaction(async (client) => {
    // Authority first, so a refused agent learns nothing about the menu.
    if (actor.kind === "agent") {
      await requireGrant(client, workspaceId, actor.roleName, OP_PROPOSE);
      await requireNotPaused(client, workspaceId);
    }
    if (change.type !== "add_item") await requireItem(client, workspaceId, change.itemId, false);
    if (sourceIds.length > 0) {
      const found = await client.query(
        `SELECT id FROM feedback_items WHERE workspace_id = $1 AND id = ANY($2::text[]);`,
        [workspaceId, sourceIds]
      );
      if (found.rows.length !== sourceIds.length) invalid("every sourceFeedbackIds entry must be feedback of this workspace.");
    }

    const inserted = await client.query(
      `INSERT INTO menu_proposals (id, workspace_id, change, rationale, source_feedback_ids, status, proposed_by)
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, 'proposed', $6)
       RETURNING *;`,
      [id, workspaceId, JSON.stringify(change), rationale, JSON.stringify(sourceIds), proposedBy]
    );
    await writeAudit(client, {
      workspaceId,
      actorType: actor.kind,
      actorId: proposedBy,
      effectClass: EffectClass.EXTERNAL_REQUEST,
      action: "menu.proposed",
      decision: PolicyDecision.ALLOW,
      evidence: { proposalId: id, changeType: change.type, sourceFeedbackIds: sourceIds },
    });
    return toProposalView(inserted.rows[0]);
  }));
}

/** An owner approves a proposed change. A decision that is not `proposed` is refused. */
export async function approveMenuProposal(workspaceId: string, proposalId: string, ownerLabel: string): Promise<MenuProposalView> {
  return decideProposal(workspaceId, proposalId, requireLabel(ownerLabel), "approved", "menu.approved");
}

/** An owner rejects a proposed change. A rejected change can never be published. */
export async function rejectMenuProposal(workspaceId: string, proposalId: string, ownerLabel: string): Promise<MenuProposalView> {
  return decideProposal(workspaceId, proposalId, requireLabel(ownerLabel), "rejected", "menu.rejected");
}

async function decideProposal(
  workspaceId: string,
  proposalId: string,
  label: string,
  next: "approved" | "rejected",
  action: string
): Promise<MenuProposalView> {
  requireWorkspace(workspaceId);
  return withTransaction(async (client) => {
    const row = await lockProposal(client, workspaceId, proposalId);
    if (row.status !== "proposed") throw new MenuError("NOT_PROPOSED");
    const updated = await client.query(
      `UPDATE menu_proposals SET status = $3, decided_by = $4, updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2 RETURNING *;`,
      [proposalId, workspaceId, next, `owner:${label}`]
    );
    await writeAudit(client, {
      workspaceId,
      actorType: "owner",
      actorId: `owner:${label}`,
      effectClass: EffectClass.READ,
      action,
      decision: PolicyDecision.ALLOW,
      evidence: { proposalId, changeType: (row.change as MenuChange).type },
    });
    return toProposalView(updated.rows[0]);
  });
}

/** An owner cancels a proposed or approved change. Cancelling a cancelled change returns it unchanged. */
export async function cancelMenuProposal(workspaceId: string, proposalId: string, actor: OwnerActor): Promise<MenuProposalView> {
  requireWorkspace(workspaceId);
  const label = requireLabel(actor.label);
  return withTransaction(async (client) => {
    const row = await lockProposal(client, workspaceId, proposalId);
    if (row.status === "cancelled") return toProposalView(row);
    if (row.status !== "proposed" && row.status !== "approved") throw new MenuError("NOT_CANCELLABLE");
    const updated = await client.query(
      `UPDATE menu_proposals SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND workspace_id = $2 RETURNING *;`,
      [proposalId, workspaceId]
    );
    await writeAudit(client, {
      workspaceId,
      actorType: "owner",
      actorId: `owner:${label}`,
      effectClass: EffectClass.READ,
      action: "menu.cancelled",
      decision: PolicyDecision.ALLOW,
      evidence: { proposalId, previousStatus: row.status, changeType: (row.change as MenuChange).type },
    });
    return toProposalView(updated.rows[0]);
  });
}

/**
 * Publishes an approved change in one transaction, with the proposal row locked first. An agent is checked against
 * `menu.publish_change` and refused without the grant (ROLE_NOT_PERMITTED) before anything else; the kitchen role holds no
 * such grant. A published proposal returns its stored result and applies nothing again.
 */
export async function publishMenuChange(
  workspaceId: string,
  proposalId: string,
  actor: AgentActor | OwnerActor
): Promise<MenuProposalView> {
  requireWorkspace(workspaceId);
  const actorId = identityOf(actor);
  if (actor.kind === "owner") requireLabel(actor.label);
  const refusal: RefusalAudit = {
    workspaceId,
    action: "menu.publish_refused",
    actorType: actor.kind,
    actorId,
    effectClass: EffectClass.COMMERCIAL_COMMITMENT,
    codes: PUBLISH_REFUSALS,
    proposalId,
  };
  return withRefusalAudit(refusal, () => withTransaction(async (client) => {
    if (actor.kind === "agent") {
      await requireGrant(client, workspaceId, actor.roleName, OP_PUBLISH);
      await requireNotPaused(client, workspaceId);
    }
    const row = await lockProposal(client, workspaceId, proposalId);
    if (row.status === "published") return toProposalView(row);
    if (row.status !== "approved") throw new MenuError("NOT_APPROVED");

    const change = row.change as MenuChange;
    let applied: Record<string, unknown>;
    let itemId: string;
    switch (change.type) {
      case "add_item": {
        itemId = `mi_${proposalId}`;
        try {
          await client.query(
            `INSERT INTO menu_items (id, workspace_id, name, description, price_cents, available)
             VALUES ($1, $2, $3, $4, $5, TRUE);`,
            [itemId, workspaceId, change.name, change.description ?? null, change.priceCents]
          );
        } catch (err: any) {
          if (err?.code === "23505" && err?.constraint === "uq_menu_items_name") throw new MenuError("NAME_TAKEN");
          throw err;
        }
        applied = { itemId, name: change.name, priceCents: change.priceCents };
        break;
      }
      case "update_price": {
        itemId = change.itemId;
        const item = await requireItem(client, workspaceId, itemId, true);
        await client.query(
          `UPDATE menu_items SET price_cents = $3, updated_at = NOW() WHERE id = $1 AND workspace_id = $2;`,
          [change.itemId, workspaceId, change.priceCents]
        );
        applied = { previousPriceCents: Number(item.price_cents), newPriceCents: change.priceCents };
        break;
      }
      case "remove_item": {
        itemId = change.itemId;
        await requireItem(client, workspaceId, itemId, true);
        // Removal keeps the row and its name. The item is only no longer offered.
        await client.query(
          `UPDATE menu_items SET available = FALSE, updated_at = NOW() WHERE id = $1 AND workspace_id = $2;`,
          [change.itemId, workspaceId]
        );
        applied = { available: false };
        break;
      }
    }

    const updated = await client.query(
      `UPDATE menu_proposals SET status = 'published', applied = $3::jsonb, updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2 RETURNING *;`,
      [proposalId, workspaceId, JSON.stringify(applied)]
    );
    await writeAudit(client, {
      workspaceId,
      actorType: actor.kind,
      actorId,
      effectClass: EffectClass.COMMERCIAL_COMMITMENT,
      action: "menu.published",
      decision: PolicyDecision.ALLOW,
      evidence: { proposalId, changeType: change.type, itemId },
    });
    return toProposalView(updated.rows[0]);
  }));
}

/** The most recent proposals of the workspace, newest first. Rationale is returned as data. */
export async function listMenuProposals(workspaceId: string): Promise<MenuProposalView[]> {
  const res = await query(
    `SELECT * FROM menu_proposals WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2;`,
    [workspaceId, LIST_LIMIT]
  );
  return res.rows.map(toProposalView);
}

/** The menu of the workspace, by name. A removed item stays listed with `available` false. */
export async function listMenu(workspaceId: string): Promise<MenuItemView[]> {
  const res = await query(
    `SELECT id, name, description, price_cents, available, updated_at FROM menu_items
     WHERE workspace_id = $1 ORDER BY lower(name) ASC, id ASC LIMIT $2;`,
    [workspaceId, MENU_LIMIT]
  );
  return res.rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    priceCents: Number(r.price_cents),
    available: r.available === true,
    updatedAt: r.updated_at as Date,
  }));
}
