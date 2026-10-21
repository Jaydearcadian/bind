/*
 * Help (ADR 0068; UX brief: "People, Settings, Help and the shell"). Short, searchable answers written for owners and staff.
 * Each answer says only what Bind does today; where something is coming it says so. Deliberately no "Ask Bind": a confident
 * wrong answer about limits or spending would do harm. A link like /app/help#pause opens that answer.
 */
import { BindApiError, clearKey, client, h, pauseControl, shell, showDemo, showPaused, storedKey, toSignIn } from "/app/core.js";

const key = storedKey();
if (!key) toSignIn();
const bind = client(key);
const $ = (id) => document.getElementById(id);

const TOPICS = [
  {
    id: "what-is-bind",
    q: "What does Bind do?",
    a: "Bind connects your business tools to a team of agents and keeps them inside the rules you set. Agents do the routine work, like checking stock and asking suppliers for quotes. You step in for anything that commits the business beyond your limits.",
  },
  {
    id: "approve",
    q: "How do I approve or reject a purchase?",
    a: "Open the item under \"Needs you\" on Today. It says what was asked, why, how much, and what happens if you do nothing. Larger amounts ask for a hold or for the amount to be typed, so a stray tap can't approve them. Only owners can approve.",
    more: ["/app/", "Go to Today"],
  },
  {
    id: "limits",
    q: "What are the limits, and who enforces them?",
    a: "Two numbers in Team and limits: the amount above which agents must ask you, and the most they may spend in a day. Bind's code checks them before anything is bought. The agents can't change them or talk their way past them.",
    more: ["/app/team", "Open Team and limits"],
  },
  {
    id: "pause",
    q: "How do I stop everything at once?",
    a: "Use \"Pause all agents\" in the header (owners only). Nothing new is ordered or committed until you resume. Reading, reviewing and cancelling still work, and work already sent to a supplier isn't recalled.",
  },
  {
    id: "simulated",
    q: "What does \"Simulated\" mean?",
    a: "A practice supplier or connection. Its quotes are made up and nothing is really ordered or paid. Bind labels simulated things everywhere they appear so they're never mistaken for real ones.",
  },
  {
    id: "statuses",
    q: "What's the difference between sent, confirmed and paid?",
    a: "Sent means Bind passed the order to the supplier. Confirmed means the supplier accepted it. Paid and matched means the payment went through and was matched to the order. Bind never shows a later step before it has happened.",
    more: ["/app/data#purchases", "See purchases"],
  },
  {
    id: "verified",
    q: "What do \"Verified live\" and \"Approved by you\" mean?",
    a: "\"Verified live\" appears only after Bind tested a connection against the real service and it worked. \"Approved by you\" means you vouched for a supplier, so agents may buy from them inside your limits. That is your decision, not a live test.",
    more: ["/app/connections", "Open Connections"],
  },
  {
    id: "keys",
    q: "Are my keys and passwords safe?",
    a: "Keys you add in Connections are sent once, stored encrypted, and never shown again, not even to you. Agents never see them; Bind's code uses them on the agents' behalf.",
  },
  {
    id: "invite",
    q: "How do I add someone to my team?",
    a: "In People, make an invite link and send it to them. They join as staff and you can make them an owner afterwards. Joining needs Google or wallet sign-in, which opens with the next release.",
    more: ["/app/people", "Open People"],
  },
  {
    id: "staff",
    q: "What can staff do?",
    a: "Staff can see everything in the workspace and propose work. They can't approve spending, change limits, manage people or see keys.",
  },
  {
    id: "activity",
    q: "Where can I see what the agents did?",
    a: "Activity lists everything in plain words, newest first. \"Follow this\" shows the whole story of one order or request, from the first check to where it stands now.",
    more: ["/app/activity", "Open Activity"],
  },
  {
    id: "builders",
    q: "Can I connect my own software?",
    a: "Yes. Owners can make an access key in Settings, under For builders, and use it with Bind's API, the SDK or an MCP tool. A key can do only what its role allows, and everything it does shows in Activity.",
    more: ["/app/settings", "Open Settings"],
  },
  {
    id: "demo",
    q: "What is the demo workspace?",
    a: "A throwaway workspace with sample data and simulated suppliers. It lasts four hours, you can reset it any time, and nothing in it is real. \"Make this yours\" starts a real workspace.",
  },
];

function render(query) {
  const q = query.trim().toLowerCase();
  const shown = TOPICS.filter((t) => !q || `${t.q} ${t.a}`.toLowerCase().includes(q));
  const list = $("help-list");
  list.replaceChildren(
    ...shown.map((t) =>
      h(
        "details",
        { class: "help-item", id: t.id },
        h("summary", {}, t.q),
        h("div", { class: "help-answer" }, h("p", {}, t.a), t.more ? h("a", { class: "text-link", href: t.more[0] }, t.more[1]) : null)
      )
    )
  );
  const hits = $("help-hits");
  hits.hidden = !q;
  hits.textContent = shown.length ? `${shown.length} ${shown.length === 1 ? "answer" : "answers"}` : `No answers mention "${query.trim()}". Try a shorter word.`;
  if (q && shown.length === 1) list.querySelector("details").open = true;
}

function openFromHash() {
  const id = window.location.hash.slice(1);
  // A search can hide the answer a link points to: show everything again first.
  if (id && !document.getElementById(id) && TOPICS.some((t) => t.id === id)) {
    $("help-search").value = "";
    render("");
  }
  const el = id && document.getElementById(id);
  if (el && el.tagName === "DETAILS") {
    el.open = true;
    el.querySelector("summary").focus();
  }
}

async function main() {
  render("");
  openFromHash();
  window.addEventListener("hashchange", openFromHash);
  $("help-search").addEventListener("input", (e) => render(e.target.value));
  try {
    const me = await bind.me();
    shell({
      me,
      onSignOut: async () => {
        if (me.credential === "account_session") await bind.call("signOut", {}).catch(() => undefined);
        clearKey();
        window.location.replace("/app/sign-in");
      },
    });
    showPaused(me.agentsPaused, me.role);
    pauseControl({ bind, me, isPaused: () => me.agentsPaused, onChange: (p) => { me.agentsPaused = p; showPaused(p, me.role); } });
    $("refresh-now").addEventListener("click", () => window.location.reload());
    bind.workspace(me.workspaceId).then((ws) => showDemo({ bind, me, ws: ws.workspace }), () => undefined);
  } catch (err) {
    if (err instanceof BindApiError && (err.status === 401 || err.status === 404)) {
      clearKey();
      toSignIn();
      return;
    }
    // Help still reads fine offline.
    $("stale-banner").hidden = false;
  }
}

main();
