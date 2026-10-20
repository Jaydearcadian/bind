/*
 * Plain-language sentences for events (ADR 0059). Shared by Today and Activity. Built only from the event's name, actor and
 * allowlisted data; unknown events get a readable fallback, never a guess.
 */

export function agentName(actor, roles) {
  if (!actor) return "Someone";
  if (actor.type === "agent") return roles.get(actor.id) ?? "An agent";
  if (actor.type === "owner") return actor.id || "An owner";
  if (actor.type === "staff") return actor.id || "Staff";
  if (actor.type === "system") return "Bind";
  if (actor.type === "webhook") return "A connected app";
  return actor.id || "Someone";
}

const SENTENCES = {
  "order.submitted": (e) => `sent order ${e.data.orderNumber ?? ""} to the supplier`.trim(),
  "order.submission_in_doubt": () => "sent an order, but the supplier's answer is unclear. It will not be sent twice",
  "inventory.low_stock_detected": (e) => `noticed ${e.data.sku ?? "an item"} is running low`,
  "replenishment.proposed": (e) => `proposed a reorder${e.data.sku ? ` of ${e.data.sku}` : ""}`,
  "commitment.evaluated": (e) => (e.decision === "REQUIRE_APPROVAL" ? "checked a purchase against your limits: it needs your approval" : e.decision === "DENY" ? "checked a purchase against your limits: refused" : "checked a purchase against your limits: within them"),
  "commitment.rechecked": () => "checked the purchase against your limits again",
  "approval.approved": () => "approved a purchase",
  "approval.rejected": () => "rejected a purchase",
  "approval.revoked": () => "withdrew an approval",
  "workflow.cancelled": () => "cancelled a piece of work",
  "workspace.agents_pause_changed": (e) => (e.data.state === "paused" || e.data.paused === true ? "paused all agents" : "resumed all agents"),
  "token.issued": () => "created an access key",
  "token.revoked": () => "revoked an access key",
  "settlement.submitted": () => "sent a payment. Waiting for it to settle",
  "settlement.held_for_pause": () => "held a payment because agents are paused",
  "accounting.three_way_match_failed": () => "found an invoice that doesn't match the order",
  "customer_order.accepted": () => "accepted a customer order",
  "customer_order.held": () => "held a customer order for your decision",
  "customer_order.declined": () => "declined a customer order",
  "customer_order.fulfilled": () => "marked a customer order fulfilled",
  "customer_order.cancelled": () => "cancelled a customer order",
  "feedback.ingested": () => "received new feedback",
  "menu.proposed": () => "suggested a menu change",
  "menu.published": () => "published a menu change",
  "document.staged": () => "read a document and drafted an entry for you to confirm",
  "document.quote_confirmed": () => "confirmed a quote from a document",
  "member.joined": () => "a new person joined the workspace",
  "invite.created": () => "created an invitation",
  "notification.skipped_no_recipient": () => "had a notice to send but no one to send it to",
  "notification.failed": () => "couldn't deliver a notice",
};

export function sentence(e, roles) {
  const verb = SENTENCES[e.name];
  const who = agentName(e.actor, roles);
  if (verb) {
    const v = verb(e);
    // A few sentences already name their subject.
    return /^a new person/.test(v) ? v.charAt(0).toUpperCase() + v.slice(1) : `${who} ${v}.`;
  }
  const [obj, act] = (e.name || e.type || "").split(".");
  return `${who}: ${(obj || "").replace(/_/g, " ")} ${(act || "").replace(/_/g, " ")}.`;
}

export function tone(e) {
  if (e.decision === "DENY" || /failed|invalid|in_doubt/.test(e.name)) return "refused";
  if (e.decision === "REQUIRE_APPROVAL" || /held/.test(e.name)) return "pending";
  if (/approved|submitted|accepted|fulfilled|published|confirmed/.test(e.name)) return "approved";
  return "idle";
}

