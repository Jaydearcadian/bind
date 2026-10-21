/*
 * "Getting started" on Today (ADR 0069; UX brief: "First run"). Owners of a real workspace see the few steps that make Bind
 * theirs. Each step is ticked from what the server holds (an approved real supplier, a connected tool, someone invited), except
 * looking over the limits, which only the owner can say they've done, so it is their tick, kept on this device. The list
 * goes away when every step is done, or when the owner hides it.
 */
import { h } from "/app/core.js";

const DONE_KEY = (ws) => `bind-starter-limits:${ws}`;
const HIDE_KEY = (ws) => `bind-starter-hidden:${ws}`;

function read(k) {
  try {
    return window.localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
}
function write(k) {
  try {
    window.localStorage.setItem(k, "1");
  } catch {
    // No storage: the tick lasts for this page only.
  }
}

export async function showStarter({ bind, me, ws }) {
  const box = document.getElementById("starter");
  if (!box || me.role !== "owner" || ws.is_demo || read(HIDE_KEY(ws.id))) return;
  const id = { params: { id: ws.id } };
  const [suppliers, connectors, invites, members] = await Promise.all([
    bind.call("listSuppliers", id).catch(() => null),
    bind.call("listConnectors", id).catch(() => null),
    bind.call("listInvites", id).catch(() => null),
    bind.call("listMembers", id).catch(() => null),
  ]);
  let limitsDone = read(DONE_KEY(ws.id));
  const steps = () => [
    {
      key: "limits",
      title: "Look over your limits",
      sub: "How much agents may spend, and when they must ask you.",
      href: "/app/team",
      done: limitsDone,
      tick: true,
    },
    {
      key: "supplier",
      title: "Approve a real supplier",
      sub: "Until then, agents only practise with simulated ones.",
      href: "/app/connections",
      done: !!suppliers?.some((s) => !s.is_simulated && s.verified),
    },
    {
      key: "tool",
      title: "Connect a tool",
      sub: "Accounting, messaging or a supplier's system.",
      href: "/app/connections",
      done: !!connectors?.some((c) => c.status !== "revoked"),
    },
    {
      key: "people",
      title: "Invite someone",
      sub: "Staff can see the work and propose; you approve.",
      href: "/app/people",
      done: !!(invites?.length || members?.length),
    },
  ];

  const render = () => {
    const list = steps();
    const left = list.filter((s) => !s.done).length;
    if (!left) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.replaceChildren(
      h(
        "div",
        { class: "panel-head" },
        h("h2", { id: "starter-title" }, "Getting started"),
        h("span", { class: "role-note" }, `${list.length - left} of ${list.length} done`)
      ),
      h(
        "ol",
        { class: "starter-steps" },
        list.map((s) =>
          h(
            "li",
            { class: `starter-step${s.done ? " is-done" : ""}` },
            h("span", { class: "starter-check", "aria-hidden": "true" }),
            h("div", { class: "line-main" }, h("a", { class: "line-title", href: s.href }, s.title), h("p", { class: "line-sub" }, s.done ? "Done" : s.sub)),
            s.tick && !s.done
              ? h(
                  "button",
                  {
                    class: "btn-small",
                    type: "button",
                    "aria-label": `Mark "${s.title}" as done`,
                    onclick: () => {
                      write(DONE_KEY(ws.id));
                      limitsDone = true;
                      render();
                    },
                  },
                  "They look right"
                )
              : null
          )
        )
      ),
      h(
        "button",
        {
          class: "link-btn",
          type: "button",
          onclick: () => {
            write(HIDE_KEY(ws.id));
            box.hidden = true;
          },
        },
        "Hide this list"
      )
    );
  };
  render();
}
