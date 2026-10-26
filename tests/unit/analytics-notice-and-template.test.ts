import { describe, it, expect } from "vitest";
import { buildOwnerNoticeEmail } from "../../src/notifications/email.js";
import { ownerNoticeIdempotencyKey } from "../../src/notifications/dispatch.js";
import { getTemplate, templateHasAnalytics, listTemplates } from "../../src/templates/registry.js";
import { ANALYTICS_SOURCE_KIND } from "../../src/templates/types.js";
import { socialTemplate } from "../../src/templates/social-v1.js";
import { kitchenTemplate } from "../../src/templates/kitchen-v1.js";
import { agencyTemplate } from "../../src/templates/agency-v1.js";
import { classifyOperation, EffectClass } from "../../src/policy/effect-classifier.js";

describe("the report-ready owner notice", () => {
  it("names that a report is ready and nothing in it: no figure, no percentage, no account", () => {
    const email = buildOwnerNoticeEmail({
      kind: "analytics_report",
      metadata: { noticeKind: "analytics_report", findings: "Reels did 40% better", brandLabel: "Acme Soup" },
      baseUrl: "https://bind.example",
    });
    expect(email.subject).toBe("Something is waiting for you in Bind");
    expect(email.text).toContain("Your report is ready.");
    expect(email.text).toContain("https://bind.example/app/");
    expect(email.text).toContain("Reading it changes nothing.");
    expect(email.text).not.toMatch(/%|better|reel|Acme|Soup|median|findings/i);
  });

  it("keeps the approval and order sentences as they were", () => {
    const approval = buildOwnerNoticeEmail({ kind: "approval", metadata: { supplierName: "Metro", amountCents: 12345 }, baseUrl: "https://bind.example" });
    expect(approval.text).toContain("A purchase from Metro for $123.45 USDC is waiting for your approval.");
    expect(approval.text).toContain("Open Bind to look at it and decide. Nothing happens until you do.");
  });

  it("refuses a notice kind it does not know", () => {
    expect(() => buildOwnerNoticeEmail({ kind: "analytics_findings", metadata: {}, baseUrl: "https://bind.example" })).toThrow(/no known kind/);
  });

  it("keys the ledger per (workspace, kind, report) and per additional recipient", () => {
    expect(ownerNoticeIdempotencyKey("ws-1", "analytics_report", "rpt_9")).toBe("ws-1:notify:analytics_report:rpt_9");
    expect(ownerNoticeIdempotencyKey("ws-1", "analytics_report", "rpt_9", "oem_2")).toBe("ws-1:notify:analytics_report:rpt_9:oem_2");
  });

  it("is an external request on the ledger's map, which is what a notice is", () => {
    expect(classifyOperation("notifications.send_summary")).toBe(EffectClass.EXTERNAL_REQUEST);
  });
});

describe("the template declares its analytics data source (docs/decisions/0090)", () => {
  it("social-v1 declares the analytics source, with its real ids", () => {
    expect(templateHasAnalytics(socialTemplate)).toBe(true);
    expect(socialTemplate.dataSources).toEqual([
      { id: "post_analytics", label: "Post analytics (simulated until a provider is connected)", kind: ANALYTICS_SOURCE_KIND, readOnly: true },
    ]);
    expect(socialTemplate.outputs).toEqual([expect.objectContaining({ id: "analytics_report", kind: "report" })]);
    expect(socialTemplate.triggers?.map((t) => t.id)).toEqual(["weekly_report", "on_demand_report"]);
  });

  it("the kitchen and the agency have no analytics module", () => {
    expect(templateHasAnalytics(kitchenTemplate)).toBe(false);
    expect(templateHasAnalytics(agencyTemplate)).toBe(false);
    expect(getTemplate("kitchen-v1") && templateHasAnalytics(getTemplate("kitchen-v1")!)).toBe(false);
  });

  it("a template that names no template (a blank workspace) has no analytics module", () => {
    expect(getTemplate("ws-not-a-template")).toBeUndefined();
    expect(listTemplates().filter(templateHasAnalytics).map((t) => t.templateId)).toEqual(["social-v1"]);
  });

  it("the social template still moves no money and has no commercial commitment", () => {
    for (const role of socialTemplate.roles) {
      expect(role.permittedEffects).not.toContain(EffectClass.COMMERCIAL_COMMITMENT);
      expect(role.spendingLimitCents).toBe(0n);
    }
  });
});

describe("the report-ready notice for simulated data (review S5)", () => {
  it("says the report is sample data when the report is simulated, and names nothing else", () => {
    const email = buildOwnerNoticeEmail({ kind: "analytics_report", metadata: { noticeKind: "analytics_report", simulated: true }, baseUrl: "https://bind.example" });
    expect(email.text).toContain("Your report is ready (sample data).");
    expect(email.text).not.toMatch(/%|median|reach|engagement|posts/i);
  });

  it("says nothing about sample data for a real report", () => {
    const email = buildOwnerNoticeEmail({ kind: "analytics_report", metadata: { noticeKind: "analytics_report", simulated: false }, baseUrl: "https://bind.example" });
    expect(email.text).toContain("Your report is ready.");
    expect(email.text).not.toContain("sample data");
  });
});
