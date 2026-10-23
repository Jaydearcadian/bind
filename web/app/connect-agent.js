/*
 * Connect an agent (ADR 0076). An owner makes a staff key for an agent they run elsewhere (Claude, Cursor, their own code),
 * gets the exact setup text for the tool, and tests the connection against Bind's hosted MCP endpoint (ADR 0075). The key is
 * shown once and kept only in this page's memory until "Done". An agent has a staff key: it can read and ask, never approve,
 * pay or see keys, and its name is on everything it does.
 */
import { BindApiError, ago, clearKey, client, h, newKey, pauseControl, shell, showDemo, showPaused, signOutNow, storedKey, toSignIn, toast } from "/app/core.js";

const key = storedKey();
if (!key) toSignIn();
const bind = client(key);
const $ = (id) => document.getElementById(id);

const PREFIX = "agent: ";
const state = { me: null, made: null, tokens: [], removing: null };

/** Plain words for what each tool lets an agent do. Anything not listed shows under its own name. */
const TOOL_WORDS = {
  get_workspace: ["look", "See the workspace's settings"],
  list_inventory: ["look", "Look at stock levels"],
  list_approvals: ["look", "See what's waiting for approval"],
  list_orders: ["look", "See purchases"],
  list_workflows: ["look", "See what work is in progress"],
  needs_attention: ["look", "See what needs the owner"],
  list_customer_orders: ["look", "See customer orders"],
  list_menu: ["look", "See the menu"],
  list_menu_proposals: ["look", "See proposed menu changes"],
  feedback_summary: ["look", "Read the feedback summary"],
  list_audit: ["look", "Read the activity record"],
  poll_events: ["look", "Follow new events"],
  request_replenishment: ["ask", "Ask for a reorder (an owner still approves it)"],
  create_customer_order: ["ask", "Take a customer order"],
  cancel_customer_order: ["ask", "Cancel a customer order"],
  submit_feedback: ["ask", "Record customer feedback"],
  propose_menu_change: ["ask", "Propose a menu change (an owner publishes it)"],
};

const endpoint = () => `${window.location.origin}/mcp`;

function slug(name) {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "agent";
}

function selectedTool() {
  return document.querySelector('input[name="tool"]:checked')?.value || "claude-code";
}

/** The exact text to paste for a tool. The key is in it, so it exists only while the setup panel is open. */
function snippetFor(tool, agentKey, name) {
  const url = endpoint();
  const header = `Authorization: Bearer ${agentKey}`;
  switch (tool) {
    case "claude-code":
      return {
        intro: "Run this once in your terminal. Claude Code then has Bind's tools.",
        text: `claude mcp add --transport http bind-${slug(name)} ${url} --header "${header}"`,
      };
    case "claude-desktop":
      return {
        intro: "Add this to Claude Desktop's configuration file (Settings, Developer, Edit Config), then restart it. It uses a small bridge program that needs Node.js.",
        text: JSON.stringify({ mcpServers: { [`bind-${slug(name)}`]: { command: "npx", args: ["-y", "mcp-remote", url, "--header", header] } } }, null, 2),
      };
    case "cursor":
      return {
        intro: "Add this to .cursor/mcp.json in your project, or to the global Cursor MCP settings.",
        text: JSON.stringify({ mcpServers: { [`bind-${slug(name)}`]: { url, headers: { Authorization: `Bearer ${agentKey}` } } } }, null, 2),
      };
    case "code":
      return {
        intro: "Call Bind's API with the key as a bearer token. This checks it works; the API description lists everything it can do.",
        text: `curl ${window.location.origin}/api/me \\\n  -H "${header}"`,
      };
    default:
      return {
        intro: "In your tool's MCP settings, add a server of type \"Streamable HTTP\" with this address, and send the key as a header.",
        text: `Address:  ${url}\nHeader:   Authorization\nValue:    Bearer ${agentKey}`,
      };
  }
}

// ---- Keys -------------------------------------------------------------------------------------------------------------

function errorText(err, fallback) {
  if (err instanceof BindApiError) {
    if (err.status === 403) return "Only owners can do that.";
    if (err.status === 429) return "Too many tries. Wait a minute, then try again.";
    if (err.status === 0 || err.status >= 500) return "Can't reach Bind right now. Try again in a moment.";
  }
  return fallback;
}

function renderAgents() {
  const list = $("agents");
  list.removeAttribute("aria-busy");
  const mine = state.tokens.filter((t) => t.role === "staff" && !t.revokedAt && String(t.label).startsWith(PREFIX));
  list.replaceChildren(
    ...(mine.length ? [] : [h("li", { class: "line-empty" }, "No agents have a key yet.")]),
    ...mine.map((t) =>
      h(
        "li",
        { class: "line" },
        h("div", { class: "line-main" }, h("p", { class: "line-title" }, String(t.label).slice(PREFIX.length)), h("p", { class: "line-sub" }, `Staff key · made ${ago(t.createdAt)}`)),
        h("button", { class: "btn-small", type: "button", "aria-label": `Remove the key for ${String(t.label).slice(PREFIX.length)}`, onclick: () => removeAgent(t) }, "Remove")
      )
    )
  );
}

async function loadAgents() {
  state.tokens = await bind.call("listTokens", { params: { id: state.me.workspaceId } });
  renderAgents();
}

function removeAgent(t) {
  const name = String(t.label).slice(PREFIX.length);
  $("confirm-title").textContent = `Remove the key for ${name}?`;
  $("confirm-text").textContent = "That agent stops working at once. What it already did stays in Activity.";
  $("confirm-go").textContent = "Remove key";
  $("confirm-error").hidden = true;
  state.removing = t;
  $("confirm-sheet").showModal();
}

function wireConfirm() {
  const sheet = $("confirm-sheet");
  sheet.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => sheet.close()));
  $("confirm-go").addEventListener("click", async () => {
    const t = state.removing;
    if (!t) return;
    $("confirm-go").disabled = true;
    try {
      await bind.call("revokeToken", { params: { id: state.me.workspaceId, tokenId: t.id }, idempotencyKey: newKey() });
      sheet.close();
      toast("The key was removed. That agent can no longer connect.");
      await loadAgents().catch(() => undefined);
    } catch (err) {
      $("confirm-error").textContent = errorText(err, "Couldn't remove it. Try again.");
      $("confirm-error").hidden = false;
    } finally {
      $("confirm-go").disabled = false;
    }
  });
}

// ---- Setup text and the connection test -------------------------------------------------------------------------------

function renderSetup() {
  if (!state.made) return;
  const { intro, text } = snippetFor(selectedTool(), state.made.token, state.made.name);
  $("setup").hidden = false;
  $("setup-intro").textContent = intro;
  $("snippet").textContent = text;
}

/** One MCP request over HTTP. The reply is JSON, or a server-sent event carrying the JSON (either is valid). */
async function mcp(agentKey, body) {
  const res = await fetch("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${agentKey}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error("http"), { status: res.status });
  const type = res.headers.get("content-type") || "";
  const raw = type.includes("text/event-stream") ? (text.split("\n").find((l) => l.startsWith("data:")) || "").slice(5).trim() : text;
  return JSON.parse(raw);
}

function describeTools(tools) {
  const look = [];
  const ask = [];
  const other = [];
  for (const t of tools) {
    const known = TOOL_WORDS[t.name];
    if (!known) other.push(t.name);
    else (known[0] === "look" ? look : ask).push(known[1]);
  }
  const group = (title, items) => (items.length ? [h("p", { class: "tools-head" }, title), h("ul", { class: "effects" }, items.map((i) => h("li", { class: "effect" }, i)))] : []);
  return h(
    "div",
    { class: "test-ok" },
    h("p", { class: "line-title" }, `Connected. This agent can use ${tools.length} tools.`),
    ...group("It can look", look),
    ...group("It can ask", ask),
    ...group("Other tools", other),
    h("p", { class: "help" }, "It can't approve or reject a purchase, make a payment, or see keys. Those stay with people.")
  );
}

async function testConnection() {
  const btn = $("test-btn");
  const out = $("test-result");
  if (!state.made) return;
  btn.disabled = true;
  out.replaceChildren(h("p", { class: "help" }, "Testing…"));
  try {
    await mcp(state.made.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bind-connect-page", version: "1" } } });
    const listed = await mcp(state.made.token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = listed?.result?.tools;
    if (!Array.isArray(tools)) throw new Error("shape");
    out.replaceChildren(describeTools(tools));
  } catch (err) {
    const status = err && err.status;
    out.replaceChildren(
      h(
        "p",
        { class: "error", role: "alert" },
        status === 401 || status === 403
          ? "Bind refused the key. Make a new key and try again."
          : status === 404 || status === 503
            ? "This Bind server doesn't have the agent endpoint available right now."
            : "Couldn't reach the agent endpoint. Check your connection and try again."
      )
    );
  } finally {
    btn.disabled = false;
  }
}

function closeSetup() {
  // The key leaves the page here.
  state.made = null;
  $("snippet").textContent = "";
  $("test-result").replaceChildren();
  $("setup").hidden = true;
  $("agent-form").hidden = false;
  $("agent-name").value = "";
  $("agent-name").focus();
}

function wire() {
  $("tools").addEventListener("change", renderSetup);
  $("agent-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("agent-name").value.trim();
    const err = $("agent-error");
    if (name.length < 2) {
      err.textContent = "Give it a name, like what it does.";
      err.hidden = false;
      $("agent-name").focus();
      return;
    }
    err.hidden = true;
    $("agent-make").disabled = true;
    try {
      const made = await bind.call("issueToken", { params: { id: state.me.workspaceId }, body: { role: "staff", label: `${PREFIX}${name}` } });
      state.made = { token: made.token, name };
      $("agent-form").hidden = true;
      renderSetup();
      $("snippet").focus();
      await loadAgents().catch(() => undefined);
    } catch (e2) {
      err.textContent = errorText(e2, "Couldn't make the key. Try again.");
      err.hidden = false;
    } finally {
      $("agent-make").disabled = false;
    }
  });
  $("snippet-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("snippet").textContent);
      toast("Copied. It contains the key, so paste it only where you mean to.");
    } catch {
      toast("Select the text and copy it.");
    }
  });
  $("test-btn").addEventListener("click", testConnection);
  $("setup-done").addEventListener("click", closeSetup);
}

// ---- Page -------------------------------------------------------------------------------------------------------------

async function main() {
  try {
    state.me = await bind.me();
  } catch (err) {
    if (err instanceof BindApiError && (err.status === 401 || err.status === 404)) {
      clearKey();
      toSignIn();
      return;
    }
    $("stale-banner").hidden = false;
    return;
  }
  shell({ me: state.me, onSignOut: () => signOutNow(bind, state.me) });
  showPaused(state.me.agentsPaused, state.me.role);
  pauseControl({ bind, me: state.me, isPaused: () => state.me.agentsPaused, onChange: (p) => { state.me.agentsPaused = p; showPaused(p, state.me.role); } });
  $("refresh-now").addEventListener("click", () => window.location.reload());
  bind.workspace(state.me.workspaceId).then((ws) => showDemo({ bind, me: state.me, ws: ws.workspace }), () => undefined);
  if (state.me.role !== "owner") {
    $("staff-note").hidden = false;
    return;
  }
  $("owner-area").hidden = false;
  wire();
  wireConfirm();
  await loadAgents().catch(() => {
    $("agents").replaceChildren(h("li", { class: "line-empty" }, "Couldn't load the list right now."));
  });
}

main();
