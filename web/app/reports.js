/*
 * Reports (ADR 0090): the brands whose posts Bind reads, and the plain-words reports made from them. Reading only. Report
 * text is written by Bind's own fixed rules from numbers, never from post text; it is still set as text, never as markup.
 * Until a real Instagram account is connected, a brand is a sample: made-up posts, labelled as such everywhere.
 */
import { BindApiError, ago, clearKey, client, h, newKey, pauseControl, shell, showDemo, showPaused, signOutNow, storedKey, toSignIn, toast } from "/app/core.js";

const key = storedKey();
if (!key) toSignIn();
const bind = client(key);
const $ = (id) => document.getElementById(id);

const state = { me: null, ws: null, accounts: [], reports: [], openId: null, busy: false };

function errorText(err, fallback) {
  if (err instanceof BindApiError) {
    const code = err.code || "";
    if (code === "ANALYTICS_DEMO_REFUSED" || err.status === 403) return "Only owners of a real workspace can do that. A demo is read only.";
    if (code === "ANALYTICS_ACCOUNT_LIMIT") return "You already have the most brands this workspace allows.";
    if (code === "ANALYTICS_NO_DATA_YET") return "There are no posts to report on yet. Update the brand's stats first.";
    if (code === "ANALYTICS_PROVIDER_NOT_AVAILABLE") return "Only sample data is available so far. Connecting a real account comes next.";
    if (code === "ANALYTICS_PROVIDER_UNAVAILABLE" || code === "ANALYTICS_PROVIDER_OUTPUT_INVALID" || err.status === 502) return "The stats source didn't answer properly. Try again in a few minutes.";
    if (err.status === 429 || err.status === 409) return err.message && err.message.length < 140 ? err.message : "That was done just now. Wait a little, then try again.";
    if (err.status === 400) return "That doesn't look right. Check the name and try again.";
    if (err.status === 0 || err.status >= 500) return "Can't reach Bind right now. Try again in a moment.";
  }
  return fallback;
}

const isOwner = () => state.me.role === "owner";
const brandName = (id) => state.accounts.find((a) => a.id === id)?.brandLabel ?? "All brands";

// ---- Brands -----------------------------------------------------------------------------------------------------------

function renderBrands() {
  const list = $("brands");
  list.removeAttribute("aria-busy");
  $("sample-note").hidden = !state.accounts.some((a) => a.isSimulated);
  list.replaceChildren(
    ...(state.accounts.length ? [] : [h("li", { class: "line-empty" }, isOwner() ? "No brands yet. Add one to see how reports look." : "No brands have been added yet.")]),
    ...state.accounts.map((a) =>
      h(
        "li",
        { class: "line" },
        h(
          "div",
          { class: "line-main" },
          h("p", { class: "line-title" }, a.brandLabel, a.isSimulated ? h("span", { class: "status status-outline" }, "Sample data") : null),
          h("p", { class: "line-sub" }, `${a.postCount} post${a.postCount === 1 ? "" : "s"} · ${a.lastSyncedAt ? `updated ${ago(a.lastSyncedAt)}` : "not updated yet"} · time zone ${a.timeZone}`)
        ),
        isOwner() ? h("button", { class: "btn-small", type: "button", "aria-label": `Update stats for ${a.brandLabel}`, onclick: (e) => syncBrand(a, e.currentTarget) }, "Update stats") : null
      )
    )
  );
  $("brand-add").hidden = !isOwner() || !$("brand-form").hidden;
  renderPicker();
}

function renderPicker() {
  const pick = $("report-brand");
  const keep = pick.value;
  pick.replaceChildren(h("option", { value: "" }, "All brands"), ...state.accounts.map((a) => h("option", { value: a.id }, a.brandLabel)));
  if ([...pick.options].some((o) => o.value === keep)) pick.value = keep;
  $("make-report").hidden = !isOwner() || state.accounts.length === 0;
}

async function loadBrands() {
  state.accounts = await bind.call("listAnalyticsAccounts", { params: { id: state.me.workspaceId } });
  renderBrands();
}

async function syncBrand(account, button) {
  button.disabled = true;
  try {
    await bind.call("syncAnalyticsAccount", { params: { id: state.me.workspaceId, accountId: account.id }, idempotencyKey: newKey() });
    toast(`${account.brandLabel} is up to date.`);
    await loadBrands();
  } catch (err) {
    toast(errorText(err, "Couldn't update the stats. Try again."));
    button.disabled = false;
  }
}

function wireBrandForm() {
  const form = $("brand-form");
  const zones = $("zones");
  try {
    const list = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    zones.replaceChildren(...list.map((z) => h("option", { value: z })));
    const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (mine) $("brand-zone").placeholder = mine;
  } catch {
    // No list: the field is free text and the server checks it.
  }
  $("brand-add").addEventListener("click", () => {
    form.hidden = false;
    $("brand-add").hidden = true;
    $("brand-name").focus();
  });
  $("brand-cancel").addEventListener("click", () => {
    form.hidden = true;
    $("brand-error").hidden = true;
    renderBrands();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("brand-error");
    const name = $("brand-name").value.trim();
    if (name.length < 2) {
      err.textContent = "Give the brand a name.";
      err.hidden = false;
      $("brand-name").focus();
      return;
    }
    err.hidden = true;
    $("brand-save").disabled = true;
    try {
      const zone = $("brand-zone").value.trim();
      await bind.call("createAnalyticsAccount", {
        params: { id: state.me.workspaceId },
        body: { provider: "simulated", brandLabel: name, ...(zone ? { timeZone: zone } : {}) },
        idempotencyKey: newKey(),
      });
      form.hidden = true;
      $("brand-name").value = "";
      $("brand-zone").value = "";
      toast(`${name} was added.`);
      await loadBrands();
    } catch (e2) {
      err.textContent = errorText(e2, "Couldn't add the brand. Try again.");
      err.hidden = false;
    } finally {
      $("brand-save").disabled = false;
    }
  });
}

// ---- Reports ----------------------------------------------------------------------------------------------------------

function periodText(r) {
  const fmt = (d) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${fmt(r.periodStart)} to ${fmt(r.periodEnd)}`;
}

function renderReports() {
  const list = $("reports");
  list.removeAttribute("aria-busy");
  list.replaceChildren(
    ...(state.reports.length ? [] : [h("li", { class: "line-empty" }, "No reports yet. They appear here when one is made.")]),
    ...state.reports.map((r) =>
      h(
        "li",
        { class: "line" },
        h(
          "div",
          { class: "line-main" },
          h("p", { class: "line-title" }, `${brandName(r.accountId)} · ${periodText(r)}`, r.simulated ? h("span", { class: "status status-outline" }, "Sample data") : null),
          h("p", { class: "line-sub" }, `${r.kind === "weekly" ? "Weekly report" : "Report you asked for"} · made ${ago(r.createdAt)}`)
        ),
        h("button", { class: "btn-small", type: "button", "aria-label": `Read the report for ${brandName(r.accountId)}, ${periodText(r)}`, onclick: () => openReport(r.id) }, "Read")
      )
    )
  );
}

async function loadReports() {
  const reports = await bind.call("listAnalyticsReports", { params: { id: state.me.workspaceId } });
  state.reports = reports.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  renderReports();
}

async function openReport(id) {
  let report = state.reports.find((r) => r.id === id);
  try {
    report = await bind.call("getAnalyticsReport", { params: { id: state.me.workspaceId, reportId: id } });
  } catch (err) {
    if (!report) {
      toast(errorText(err, "Couldn't open that report."));
      return;
    }
  }
  state.openId = id;
  $("report-title").textContent = `${brandName(report.accountId)}, ${periodText(report)}`;
  $("report-meta").textContent = `${report.kind === "weekly" ? "Weekly report" : "Report you asked for"} · made ${ago(report.createdAt)}${report.simulated ? " · sample data" : ""}`;
  // The text is plain paragraphs. Each is set as text.
  $("report-text").replaceChildren(...String(report.text).split(/\n{2,}/).filter(Boolean).map((p) => h("p", {}, p.trim())));
  $("report-view").hidden = false;
  $("report-view").scrollIntoView({ behavior: "smooth", block: "start" });
  $("report-title").setAttribute("tabindex", "-1");
  $("report-title").focus({ preventScroll: true });
}

function wireReportMaker() {
  $("report-make").addEventListener("click", async () => {
    if (state.busy) return;
    state.busy = true;
    const button = $("report-make");
    const err = $("report-error");
    err.hidden = true;
    button.disabled = true;
    button.textContent = "Making the report…";
    try {
      const chosen = $("report-brand").value;
      const targets = chosen ? state.accounts.filter((a) => a.id === chosen) : state.accounts;
      // A report reads stored posts, so bring each brand up to date first.
      for (const a of targets) await bind.call("syncAnalyticsAccount", { params: { id: state.me.workspaceId, accountId: a.id }, idempotencyKey: newKey() });
      const made = await bind.call("createAnalyticsReport", {
        params: { id: state.me.workspaceId },
        body: { kind: "on_demand", ...(chosen ? { accountId: chosen } : {}) },
        idempotencyKey: newKey(),
      });
      toast(made.created === false ? "That report was already made. Opening it." : "Report made.");
      await Promise.all([loadBrands(), loadReports()]);
      await openReport(made.id);
    } catch (e) {
      err.textContent = errorText(e, "Couldn't make the report. Try again.");
      err.hidden = false;
    } finally {
      state.busy = false;
      button.disabled = false;
      button.textContent = "Make a report now";
    }
  });
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
  try {
    const ws = (await bind.workspace(state.me.workspaceId)).workspace;
    state.ws = ws;
    showDemo({ bind, me: state.me, ws });
    const templates = await bind.call("listTemplates").catch(() => []);
    const tpl = Array.isArray(templates) ? templates.find((t) => t.templateId === ws.template_id) : undefined;
    const hasModule = !!tpl?.dataSources?.some((s) => s.kind === "post_analytics");
    if (!hasModule) {
      $("no-module").hidden = false;
      return;
    }
    $("module-area").hidden = false;
    wireBrandForm();
    wireReportMaker();
    await loadBrands();
    await loadReports();
    renderBrands();
    renderReports();
  } catch {
    $("stale-banner").hidden = false;
  }
}

main();
