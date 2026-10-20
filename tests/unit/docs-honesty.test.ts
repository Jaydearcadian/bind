import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Documentation honesty checks (Task 14). Each test reads the committed docs and checks one rule that a reader
 * relies on: the evidence classes, the commit a result came from, which test files exist, which npm commands the
 * README names, that the README makes no production or full-verification claim, and that every ADR is indexed.
 * They read files only. Nothing here runs a gate.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const EVIDENCE = "docs/RELEASE_EVIDENCE.md";
const README = "README.md";
const DECISIONS_INDEX = "docs/decisions/README.md";
const DECISIONS_DIR = "docs/decisions";
const PACKAGE = "package.json";

/** The five classes of AGENTS.md. Nothing else may appear as an evidence class in the release evidence. */
const EVIDENCE_CLASSES = new Set(["LOCAL_PASS", "LIVE_READ_PASS", "VERIFIED_REMOTE", "NOT_RUN", "BLOCKED"]);
/** Words that make a whole-cell token look like an evidence class. Such a token must be one of the five. */
const CLASS_LIKE = /PASS|BLOCK|RUN|FAIL|VERIFIED|APPLICABLE|UNVERIFIED|CLAIM/;

/** The part of the evidence file before its appendix. The appendix holds earlier-session claims by design. */
function mainEvidence(): string {
  const text = read(EVIDENCE);
  const at = text.search(/^## Appendix/m);
  return at === -1 ? text : text.slice(0, at);
}

/** Table rows as trimmed cell arrays, separator rows removed, with backticks and bold markers stripped. */
function tableCells(text: string): { line: string; cells: string[]; section: string }[] {
  const rows: { line: string; cells: string[]; section: string }[] = [];
  let section = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) section = line;
    if (!line.startsWith("|") || /^\|\s*:?-{3,}/.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim().replace(/[`*]/g, ""));
    rows.push({ line, cells, section });
  }
  return rows;
}

describe("docs honesty", () => {
  it("the release evidence uses only the five evidence classes", () => {
    const text = read(EVIDENCE);
    // FAILED belongs to the live-check script output (docs/TESTING_AND_RELEASE_GATES.md section 10), never here.
    expect(text, "FAILED is not an evidence class in the release evidence").not.toMatch(/\bFAILED\b/);

    const offending: string[] = [];
    for (const row of tableCells(text)) {
      for (const cell of row.cells) {
        if (/^[A-Z][A-Z0-9_]*$/.test(cell) && CLASS_LIKE.test(cell) && !EVIDENCE_CLASSES.has(cell)) {
          offending.push(`${cell} in: ${row.line.slice(0, 120)}`);
        }
      }
    }
    expect(offending, "every class cell must be one of the five classes").toEqual([]);
  });

  it("no capability row is LIVE_READ_PASS or VERIFIED_REMOTE without a recorded remote reproduction", () => {
    const text = mainEvidence();
    const recorded = /^Remote reproduction recorded:/m.test(text);
    const offending: string[] = [];
    for (const row of tableCells(text)) {
      if (!/gate|capabilit/i.test(row.section)) continue;
      for (const cell of row.cells) {
        if ((cell === "LIVE_READ_PASS" || cell === "VERIFIED_REMOTE") && !recorded) {
          offending.push(row.line.slice(0, 120));
        }
      }
    }
    expect(offending, "no remote class without a recorded remote reproduction").toEqual([]);
  });

  it("every test file named in the evidence exists", () => {
    const named = new Set<string>();
    for (const doc of [EVIDENCE, README]) {
      for (const m of read(doc).matchAll(/tests\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs)\b/g)) {
        named.add(m[0]);
      }
    }
    expect(named.size, "the evidence names test files").toBeGreaterThan(0);
    const missing = [...named].filter((p) => !fs.existsSync(path.join(ROOT, p)));
    expect(missing, "named test files that do not exist").toEqual([]);
  });

  it("every command in the README quick start exists in package.json", () => {
    const readme = read(README);
    const start = readme.indexOf("## Quick start");
    expect(start, "README has a Quick start section").toBeGreaterThan(-1);
    const after = readme.slice(start + "## Quick start".length);
    const end = after.search(/^## /m);
    const section = end === -1 ? after : after.slice(0, end);
    const names = [...section.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((m) => m[1]);
    expect(names.length, "the quick start names npm scripts").toBeGreaterThan(0);
    const scripts = (JSON.parse(read(PACKAGE)) as { scripts: Record<string, string> }).scripts;
    const missing = names.filter((n) => !(n in scripts));
    expect(missing, "quick start commands missing from package.json").toEqual([]);
  });

  it("the README does not claim production readiness or unqualified verification", () => {
    // A line may mention these words when it also says the thing is not verified, not run, or an earlier claim.
    const forbidden = [/production[- ]ready/i, /fully verified/i, /verified end[- ]to[- ]end/i, /100%\s*(?:line|function|coverage)/i];
    const qualified = /earlier|not verified|unverified|NOT_RUN|BLOCKED|not run|claim|not claimed|not a /i;
    const offending: string[] = [];
    for (const line of read(README).split("\n")) {
      if (forbidden.some((re) => re.test(line)) && !qualified.test(line)) offending.push(line.slice(0, 140));
    }
    expect(offending, "unqualified production or verification claims").toEqual([]);
  });

  it("the evidence records the commit it was produced at", () => {
    const lines = read(EVIDENCE).split("\n").filter((l) => /commit/i.test(l));
    expect(lines.some((l) => /\b[0-9a-f]{40}\b/.test(l)), "a commit line with a 40-character hash").toBe(true);
  });

  it("every ADR file is listed in the ADR index", () => {
    const adrs = fs.readdirSync(path.join(ROOT, DECISIONS_DIR)).filter((f) => /^\d{4}-.+\.md$/.test(f));
    expect(adrs.length, "ADR files exist").toBeGreaterThan(0);
    const index = read(DECISIONS_INDEX);
    const missing = adrs.filter((f) => !index.includes(f));
    expect(missing, "ADR files missing from docs/decisions/README.md").toEqual([]);
  });
});
