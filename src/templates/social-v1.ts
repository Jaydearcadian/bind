import { EffectClass } from "../policy/effect-classifier.js";
import { WorkspaceTemplate } from "./types.js";

/**
 * Social media manager (docs/decisions/0083). Reads a brand's post analytics and reports what worked, and drafts a content
 * calendar. It has no posting, ads or replies: anything public or paid needs a later, separately approved capability.
 * No role can make a commercial commitment, so no money moves under this template.
 */
export const socialTemplate: WorkspaceTemplate = {
  templateId: "social-v1",
  name: "Social media manager",
  description:
    "Reads post analytics for a brand and reports what worked (reels against other posts, followers against non-followers, time of day, country), and drafts a content calendar. It never posts, runs ads or replies: anything public or paid needs a later, separately approved capability.",
  defaultDailyLimitCents: 0n, // No spend in this template.
  defaultApprovalThresholdCents: 0n, // No spend in this template.
  roles: [
    {
      roleName: "analytics_agent",
      displayName: "Post Analytics Agent",
      description:
        "Reads post analytics for each brand and finds what worked: reels against other posts, followers against non-followers, time of day, and country. Read only: it never changes the account.",
      permittedEffects: [EffectClass.READ, EffectClass.EXTERNAL_REQUEST],
      spendingLimitCents: 0n,
      enabled: true,
    },
    {
      roleName: "reporting_agent",
      displayName: "Reporting Agent",
      description:
        "Turns the analytics findings into a short report and sends the owner a notice that it is ready. Sends nothing to the public.",
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
      id: "instagram_insights",
      label: "Instagram post insights",
      kind: "instagram_insights",
      readOnly: true,
    },
  ],
  triggers: [
    {
      id: "weekly_report",
      kind: "schedule",
      description: "Once a week, the findings are refreshed and the report is written.",
    },
    {
      id: "post_published",
      kind: "event",
      description: "When a post is published, its insights are picked up for the next report.",
    },
  ],
  outputs: [
    {
      id: "weekly_report",
      kind: "report",
      description: "A short written report of what worked, for the owner.",
    },
  ],
};
