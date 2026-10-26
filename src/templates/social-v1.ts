import { EffectClass } from "../policy/effect-classifier.js";
import { ANALYTICS_SOURCE_KIND, WorkspaceTemplate } from "./types.js";

/**
 * Social media manager (docs/decisions/0084). Reads a brand's post analytics and reports what worked, and drafts a content
 * calendar. It has no posting, ads or replies: anything public or paid needs a later, separately approved capability.
 * No role can make a commercial commitment, so no money moves under this template.
 */
export const socialTemplate: WorkspaceTemplate = {
  templateId: "social-v1",
  name: "Social media manager",
  description:
    "Reads post analytics for a brand and reports what worked (reels against other posts, followers against non-followers, time of day, country), and drafts a content calendar. Until a real analytics provider is connected, the data is simulated and labelled as such. It never posts, runs ads or replies: anything public or paid needs a later, separately approved capability.",
  defaultDailyLimitCents: 0n, // No spend in this template.
  defaultApprovalThresholdCents: 0n, // No spend in this template.
  roles: [
    {
      roleName: "analytics_agent",
      displayName: "Post Analytics Agent",
      description:
        "Reads post analytics for each brand and finds what worked: reels against other posts, followers against non-followers, time of day, and country. Read only: it never changes the account. The data is simulated until a real provider is connected.",
      permittedEffects: [EffectClass.READ, EffectClass.EXTERNAL_REQUEST],
      spendingLimitCents: 0n,
      enabled: true,
    },
    {
      roleName: "reporting_agent",
      displayName: "Reporting Agent",
      description:
        "Turns the analytics findings into a short report and tells the owner it is ready. The notice names no finding. Sends nothing to the public.",
      permittedEffects: [EffectClass.READ, EffectClass.EXTERNAL_REQUEST],
      spendingLimitCents: 0n,
      enabled: true,
    },
    {
      roleName: "content_planner_agent",
      displayName: "Content Planner Agent",
      description:
        "Drafts a content calendar and post copy from the findings. Drafts only: it never posts, schedules to a live account, or replies.",
      permittedEffects: [EffectClass.READ],
      spendingLimitCents: 0n,
      enabled: true,
    },
  ],
  dataSources: [
    {
      id: "post_analytics",
      label: "Post analytics (simulated until a provider is connected)",
      kind: ANALYTICS_SOURCE_KIND,
      readOnly: true,
    },
  ],
  triggers: [
    {
      id: "weekly_report",
      kind: "schedule",
      description:
        "Once a week, for the last full week, each brand's posts are synced and its report is written, when the worker runs with BIND_ANALYTICS_REPORTS=true (docs/RUNBOOK.md).",
    },
    {
      id: "on_demand_report",
      kind: "manual",
      description: "The owner asks for a report of a chosen period, through the API.",
    },
  ],
  outputs: [
    {
      id: "analytics_report",
      kind: "report",
      description: "A short written report of what worked, for the owner. It is read in Bind, and the notice that it is ready names nothing in it.",
    },
  ],
};
