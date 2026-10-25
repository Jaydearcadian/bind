/**
 * Source-scan guard for docs/decisions/0085: no model-facing tool moves value.
 *
 * Value moves only in the settlement adapters (src/adapters/settlement/), through the effects ledger and the commitment
 * gate. A model-facing tool may read, make an external request, or call the deterministic commitment path. This test
 * reads the source files with fs (no network, no process, no model) and fails when:
 *   (a) a value-moving primitive appears outside src/adapters/settlement/ (and the explicitly listed files);
 *   (b) a file under src/agents/ imports a value-moving module;
 *   (c) a model-facing tool is registered whose name is not in TOOL_ALLOWLIST (adding a tool forces a review);
 *   (d) a file under src/ or templates/ combines the home directory with the agents skills folder, or a deep agent
 *       loads a skills folder that is not a virtual path;
 *   (e) any file other than the unified settlement entry points calls `.transferUSDC(`.
 * Each check has a self-test that the scanner matches the text it is meant to catch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------- file helpers ----------

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".mts"];

function walk(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, keep));
    else if (keep(entry.name)) out.push(full);
  }
  return out;
}

/** Repository-relative path with forward slashes. */
function rel(full: string): string {
  return relative(ROOT, full).split(sep).join("/");
}

function readRel(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

const SRC_FILES = walk(join(ROOT, "src"), (n) => CODE_EXTENSIONS.some((e) => n.endsWith(e))).map(rel).sort();
const MCP_FILES = walk(join(ROOT, "mcp", "src"), (n) => CODE_EXTENSIONS.some((e) => n.endsWith(e))).map(rel).sort();
const PRODUCT_FILES = [...SRC_FILES, ...MCP_FILES];
const TEMPLATE_FILES = walk(join(ROOT, "templates"), () => true).map(rel).sort();

/** 1-based line number of an index in a string. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

// ---------- (a) value-moving primitives ----------

/** Text that moves value or drives a wallet. Each entry is checked against every product file. */
const VALUE_MOVING_PRIMITIVES: Array<{ name: string; pattern: RegExp }> = [
  { name: "writeContract(", pattern: /writeContract\(/ },
  { name: "sendTransaction(", pattern: /sendTransaction\(/ },
  { name: "sendRawTransaction", pattern: /sendRawTransaction/ },
  { name: "walletClient", pattern: /walletClient/ },
  { name: "circle wallet", pattern: /circle wallet/ },
  { name: "wallet execute", pattern: /wallet execute/ },
  {
    name: "child_process exec/spawn of circle",
    pattern: /\b(exec|execFile|execSync|execFileSync|spawn|spawnSync)\s*\(\s*["'`]circle["'`]/,
  },
  {
    name: "child_process exec/spawn of cast send",
    pattern: /\b(exec|execFile|execSync|execFileSync|spawn|spawnSync)\s*\(\s*["'`]cast\s+send/,
  },
  { name: "cast send argument list", pattern: /["'`]cast["'`]\s*,\s*\[\s*["'`]send["'`]/ },
];

/** Files outside src/adapters/settlement/ that may contain a listed primitive. Each one carries its reason. */
const VALUE_PRIMITIVE_EXCEPTIONS: Record<string, string> = {
  "src/adapters/circleAgentStack.ts":
    "Read-only `circle contract query` for the vendor allowlist (no settlement). Its settlement execution was removed (ADR 0085). " +
    "Checked below for write-command text.",
};

/** Text that must not appear in the exception file, so the exception stays read-only. */
const READ_ONLY_EXCEPTION_FORBIDDEN = [
  "wallet execute",
  "wallet transfer",
  "--amount",
  "settleOrder",
  "executeBindSettlement",
  "writeContract",
  "sendTransaction",
];

function isSettlementAdapter(relPath: string): boolean {
  return relPath.startsWith("src/adapters/settlement/");
}

describe("(a) value-moving primitives stay in the settlement adapters", () => {
  it("the scanner matches the text it guards (self-test)", () => {
    const samples: Array<[string, string]> = [
      ["writeContract(", "await walletClient.writeContract({ address })"],
      ["sendTransaction(", "await client.sendTransaction({ to })"],
      ["sendRawTransaction", "eth_sendRawTransaction"],
      ["walletClient", "const walletClient = createWalletClient()"],
      ["circle wallet", "run circle wallet execute now"],
      ["wallet execute", "args: ['wallet execute', 'x']"],
      ["child_process exec/spawn of circle", 'this.exec("circle", args, { timeout })'],
      ["child_process exec/spawn of cast send", 'execFile("cast send 0x1")'],
      ["cast send argument list", 'spawn("cast", ["send", "0x1"])'],
    ];
    for (const [name, text] of samples) {
      const primitive = VALUE_MOVING_PRIMITIVES.find((p) => p.name === name);
      expect(primitive, `no primitive named ${name}`).toBeDefined();
      expect(primitive!.pattern.test(text), `${name} does not match: ${text}`).toBe(true);
    }
    // A read is not a primitive.
    const read = 'this.exec("circle", ["contract", "query"], { timeout })';
    expect(VALUE_MOVING_PRIMITIVES.some((p) => p.pattern.test(read) && p.name !== "child_process exec/spawn of circle")).toBe(false);
  });

  it("the settlement adapter does contain the primitives, so the scan is not vacuous", () => {
    const arc = readRel("src/adapters/settlement/arc-l1.ts");
    expect(arc).toMatch(/writeContract\(/);
    expect(arc).toMatch(/walletClient/);
  });

  it("no product file outside src/adapters/settlement/ contains a value-moving primitive", () => {
    const violations: string[] = [];
    for (const file of PRODUCT_FILES) {
      if (isSettlementAdapter(file)) continue;
      if (VALUE_PRIMITIVE_EXCEPTIONS[file]) continue;
      const text = readRel(file);
      for (const { name, pattern } of VALUE_MOVING_PRIMITIVES) {
        const match = pattern.exec(text);
        if (match) violations.push(`${file}:${lineOf(text, match.index)} contains "${name}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("each explicit exception is read-only and still exists", () => {
    for (const [file, reason] of Object.entries(VALUE_PRIMITIVE_EXCEPTIONS)) {
      expect(reason.length, `exception ${file} needs a reason`).toBeGreaterThan(20);
      expect(PRODUCT_FILES, `exception ${file} no longer exists; remove it from the list`).toContain(file);
      const text = readRel(file);
      for (const forbidden of READ_ONLY_EXCEPTION_FORBIDDEN) {
        expect(text.includes(forbidden), `${file} contains "${forbidden}", which is a write command`).toBe(false);
      }
    }
  });
});

// ---------- (b) src/agents imports ----------

const FORBIDDEN_AGENT_IMPORTS: RegExp[] = [
  /^(node:)?child_process$/,
  /^viem\/accounts$/,
  /(^|\/)adapters\/settlement(\/|$)/,
  /(^|\/)adapters\/circleAgentStack(\.js)?$/,
  /(^|\/)workflows\/settlement(\.js)?$/,
  /(^|\/)tabs\/ledger(\.js)?$/,
];

/** Every module specifier a file imports, statically or dynamically. */
function importSpecifiers(text: string): string[] {
  const found: string[] = [];
  const patterns = [/\bfrom\s+["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\bimport\s+["']([^"']+)["']/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

describe("(b) src/agents never imports a value-moving module", () => {
  const agentFiles = PRODUCT_FILES.filter((f) => f.startsWith("src/agents/"));

  it("the agent folder is scanned and its imports are read", () => {
    expect(agentFiles.length).toBeGreaterThan(0);
    const all = agentFiles.flatMap((f) => importSpecifiers(readRel(f)));
    expect(all).toContain("@langchain/core/tools");
  });

  it("no file under src/agents imports a settlement, circle, wallet or child-process module", () => {
    const violations: string[] = [];
    for (const file of agentFiles) {
      for (const specifier of importSpecifiers(readRel(file))) {
        if (FORBIDDEN_AGENT_IMPORTS.some((re) => re.test(specifier))) {
          violations.push(`${file} imports "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("the forbidden import list matches the modules it names (self-test)", () => {
    const matches = (s: string) => FORBIDDEN_AGENT_IMPORTS.some((re) => re.test(s));
    expect(matches("../adapters/settlement/index.js")).toBe(true);
    expect(matches("../adapters/circleAgentStack.js")).toBe(true);
    expect(matches("node:child_process")).toBe(true);
    expect(matches("viem/accounts")).toBe(true);
    expect(matches("../adapters/marketBenchmark.js")).toBe(false);
    expect(matches("../effects/ledger.js")).toBe(false);
  });
});

// ---------- (c) the model-facing tool allowlist ----------

type ToolEffect = "read" | "external_request" | "commercial_commitment";

interface AllowedTool {
  /** The file that registers the tool. A move to another file is a review. */
  file: string;
  effect: ToolEffect;
  note: string;
}

/**
 * Every model-facing tool, reviewed. Adding a tool fails the test until it is listed here with its effect class.
 *
 * Effect classes (AGENTS.md): read = no change to the outside world; external_request = asks an outside party or a search
 * provider, creates no commitment; commercial_commitment = may bind money or a supplier, and must go through the commitment
 * gate (authorizeCommitment in src/policy/commitment-gate.ts, or the API route that calls it).
 */
const TOOL_ALLOWLIST: Record<string, AllowedTool> = {
  // Procurement agent (src/agents/replenishmentTools.ts, used by src/workflows/procurement.ts).
  get_business_context: {
    file: "src/agents/replenishmentTools.ts",
    effect: "read",
    note: "Business profile, template rules and policy limits from the database, workspace-scoped.",
  },
  get_stock_snapshot: {
    file: "src/agents/replenishmentTools.ts",
    effect: "read",
    note: "Stock levels from the database, workspace-scoped.",
  },
  get_approved_supplier_quotes: {
    file: "src/agents/replenishmentTools.ts",
    effect: "read",
    note: "Stored supplier quotes for the workspace. Read only; a quote request is not made here.",
  },
  create_replenishment_proposal: {
    file: "src/agents/replenishmentTools.ts",
    effect: "read",
    note:
      "Writes a proposal into the workflow's own context: no money, no supplier contact. The quantity must equal the stored quote's. " +
      "Reclassify as commercial_commitment if it ever sends anything.",
  },
  request_policy_evaluation: {
    file: "src/agents/replenishmentTools.ts",
    effect: "commercial_commitment",
    note:
      "Runs authorizeCommitment (threshold, budget, pause, approval). Only the gate decides. The owner notification send uses the effects ledger (docs/decisions/0020).",
  },
  get_request_status: {
    file: "src/agents/replenishmentTools.ts",
    effect: "read",
    note: "Workflow status, workspace-scoped (ADR 0031, row 20).",
  },
  // Procurement agent of the template harness (src/agents/bindTemplateAgent.ts).
  inspect_quotes_and_benchmarks: {
    file: "src/agents/bindTemplateAgent.ts",
    effect: "read",
    note:
      "Returns the quotes and the market benchmark that generateVerifiableDecisionRecord already holds. The tool makes no call itself.",
  },

  // MCP tool table (mcp/src/tools.ts). Each tool is one API call; the API route decides, so the MCP holds no authority.
  get_workspace: { file: "mcp/src/tools.ts", effect: "read", note: "Member read of the workspace." },
  list_inventory: { file: "mcp/src/tools.ts", effect: "read", note: "Member read of stock." },
  list_approvals: { file: "mcp/src/tools.ts", effect: "read", note: "Read only. Deciding an approval is not provided (ADR 0037)." },
  list_orders: { file: "mcp/src/tools.ts", effect: "read", note: "Member read of orders." },
  list_workflows: { file: "mcp/src/tools.ts", effect: "read", note: "Member read of workflows." },
  needs_attention: { file: "mcp/src/tools.ts", effect: "read", note: "Member read." },
  list_customer_orders: { file: "mcp/src/tools.ts", effect: "read", note: "Member read." },
  list_menu: { file: "mcp/src/tools.ts", effect: "read", note: "Member read." },
  list_menu_proposals: { file: "mcp/src/tools.ts", effect: "read", note: "Read only. Approving or publishing is not provided." },
  feedback_summary: { file: "mcp/src/tools.ts", effect: "read", note: "Member read of feedback summary." },
  list_audit: { file: "mcp/src/tools.ts", effect: "read", note: "Member read of the audit log." },
  poll_events: { file: "mcp/src/tools.ts", effect: "read", note: "Member read of the event feed." },
  request_replenishment: {
    file: "mcp/src/tools.ts",
    effect: "commercial_commitment",
    note: "POST replenish. The API's commitment gate decides; the result may be an approval waiting for an owner.",
  },
  create_customer_order: {
    file: "mcp/src/tools.ts",
    effect: "commercial_commitment",
    note: "The API decides: it may hold the order for the owner or decline it.",
  },
  cancel_customer_order: {
    file: "mcp/src/tools.ts",
    effect: "commercial_commitment",
    note: "Cancelling an accepted order. The API's gate applies.",
  },
  submit_feedback: {
    file: "mcp/src/tools.ts",
    effect: "external_request",
    note: "Stores external text as data. A repeated source and external id is a duplicate.",
  },
  propose_menu_change: {
    file: "mcp/src/tools.ts",
    effect: "external_request",
    note: "Creates a proposal that stays proposed until an owner acts through the API.",
  },
};

interface ToolSite {
  file: string;
  line: number;
  name: string | undefined;
}

/**
 * Finds each tool registration: `tool(` in src, and `tool(` or the MCP `read(` helper in mcp/src. The name is the first
 * `name: "..."` literal after the call and before the next call. A call with no literal name is reported, not skipped.
 */
function toolSites(file: string, text: string): ToolSite[] {
  const pattern = file.startsWith("mcp/")
    ? /(?<![\w.$])(tool|read)\s*\(\s*(\{|async\b|\()/g
    : /(?<![\w.$])(tool)\s*\(\s*(\{|async\b|\()/g;
  const starts: number[] = [];
  for (const match of text.matchAll(pattern)) {
    // The MCP generic `return tool({ ...spec, ... })` builds a tool from a parameter; it registers no name of its own.
    if (/\.\.\.spec\b/.test(text.slice(match.index!, match.index! + 40))) continue;
    starts.push(match.index!);
  }
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : text.length;
    const window = text.slice(start, end);
    const named = /\bname:\s*"([a-z][a-z0-9_]*)"/.exec(window);
    return { file, line: lineOf(text, start), name: named?.[1] };
  });
}

function allToolSites(): ToolSite[] {
  const files = PRODUCT_FILES.filter((f) => f.startsWith("src/") || f.startsWith("mcp/src/"));
  return files.flatMap((f) => toolSites(f, readRel(f)));
}

describe("(c) every model-facing tool is on the reviewed allowlist", () => {
  it("the tool scanner finds the registrations it should (self-test)", () => {
    const sample = [
      'const a = tool(\n  async ({ x }) => JSON.stringify(x),\n  {\n    name: "sample_read",\n    schema: z.object({}),\n  }\n);',
      'const b = tool(async () => "", { name: "sample_two", schema: z.object({}) });',
    ].join("\n");
    const sites = toolSites("src/agents/sample.ts", sample);
    expect(sites.map((s) => s.name)).toEqual(["sample_read", "sample_two"]);
    expect(sites[0].line).toBe(1);
  });

  it("every registration has a literal name (none is skipped silently)", () => {
    const unnamed = allToolSites().filter((s) => s.name === undefined);
    expect(unnamed).toEqual([]);
  });

  it("the MCP table registers the 17 tools the ADR names", () => {
    const mcp = allToolSites().filter((s) => s.file.startsWith("mcp/src/"));
    expect(mcp.map((s) => s.name).sort()).toEqual(
      Object.entries(TOOL_ALLOWLIST)
        .filter(([, t]) => t.file.startsWith("mcp/"))
        .map(([name]) => name)
        .sort()
    );
    expect(mcp).toHaveLength(17);
  });

  it("no model-facing tool outside the allowlist (adding one forces a review here)", () => {
    const unreviewed = allToolSites()
      .filter((s) => !(s.name !== undefined && s.name in TOOL_ALLOWLIST))
      .map((s) => `${s.file}:${s.line} registers "${s.name}" with no allowlist entry`);
    expect(unreviewed).toEqual([]);
  });

  it("every allowlisted tool is registered in the file it is listed for", () => {
    const sites = allToolSites();
    const problems: string[] = [];
    for (const [name, entry] of Object.entries(TOOL_ALLOWLIST)) {
      const found = sites.filter((s) => s.name === name);
      if (found.length === 0) problems.push(`${name}: listed but not registered (remove the stale entry)`);
      else if (found.length > 1) problems.push(`${name}: registered ${found.length} times`);
      else if (found[0].file !== entry.file) problems.push(`${name}: registered in ${found[0].file}, listed for ${entry.file}`);
    }
    expect(problems).toEqual([]);
  });

  it("every allowlisted tool has an effect class and a note", () => {
    const valid = new Set<ToolEffect>(["read", "external_request", "commercial_commitment"]);
    for (const [name, entry] of Object.entries(TOOL_ALLOWLIST)) {
      expect(valid.has(entry.effect), `${name} has no effect class`).toBe(true);
      expect(entry.note.length, `${name} needs a note`).toBeGreaterThan(10);
    }
  });

  it("a commercial commitment in src/ goes through authorizeCommitment (the commitment gate)", () => {
    const commitments = Object.entries(TOOL_ALLOWLIST).filter(
      ([, t]) => t.effect === "commercial_commitment" && t.file.startsWith("src/")
    );
    expect(commitments.map(([n]) => n)).toEqual(["request_policy_evaluation"]);
    for (const [name, entry] of commitments) {
      const text = readRel(entry.file);
      expect(text, `${name} does not call authorizeCommitment`).toMatch(/authorizeCommitment\(/);
      expect(text, `${name} does not import the commitment gate`).toMatch(/policy\/commitment-gate(\.js)?"/);
    }
  });

  it("the MCP never touches the database or the policy code itself (its commitments are decided by the API)", () => {
    const violations: string[] = [];
    for (const file of MCP_FILES) {
      for (const specifier of importSpecifiers(readRel(file))) {
        if (specifier === "pg" || specifier.startsWith("pg/")) violations.push(`${file} imports "${specifier}"`);
        if (/(^|\/)src\/(db|policy|workflows|tabs|adapters|effects)\//.test(specifier)) {
          violations.push(`${file} imports "${specifier}"`);
        }
        if (/^\.\.\/\.\.\/src\//.test(specifier)) violations.push(`${file} imports "${specifier}"`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// ---------- (d) no home-directory skills ----------

describe("(d) agents load only Bind's own virtual skills, never a home-directory folder", () => {
  it("no file under src/ or templates/ combines os.homedir() with the .agents folder", () => {
    const violations: string[] = [];
    const candidates = [...SRC_FILES, ...TEMPLATE_FILES];
    for (const file of candidates) {
      const text = readRel(file);
      if (/homedir/.test(text) && /\.agents/.test(text)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it("every deep agent loads only the virtual /skills/ folder, on a virtual filesystem backend", () => {
    // Only Bind's own template skills, rooted in the template directory (virtualMode: true). An absolute path such as
    // /home/<user>/.agents/skills would be a filesystem path (or a home-directory skill), so it is refused.
    const violations: string[] = [];
    let sawSkills = 0;
    for (const file of SRC_FILES) {
      const text = readRel(file);
      for (const match of text.matchAll(/\bskills:\s*(\[[^\]]*\]|[A-Za-z_$][\w$.]*)/g)) {
        sawSkills++;
        const value = match[1];
        const where = `${file}:${lineOf(text, match.index!)}`;
        if (!value.startsWith("[")) {
          violations.push(`${where} skills is "${value}", not a literal list`);
          continue;
        }
        const literals = [...value.matchAll(/["'`]([^"'`]*)["'`]/g)].map((m) => m[1]);
        for (const literal of literals) {
          if (literal !== "/skills/") violations.push(`${where} skill path "${literal}" is not the virtual /skills/ folder`);
        }
        if (!/virtualMode:\s*true/.test(text)) violations.push(`${where} loads skills without virtualMode: true`);
      }
    }
    expect(sawSkills).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it("the skills rule refuses an absolute home-directory path (self-test)", () => {
    const literalsOf = (value: string) => [...value.matchAll(/["'`]([^"'`]*)["'`]/g)].map((m) => m[1]);
    expect(literalsOf('["/skills/"]').every((l) => l === "/skills/")).toBe(true);
    expect(literalsOf('["/home/user/.agents/skills"]').every((l) => l === "/skills/")).toBe(false);
  });
});

// ---------- (e) one caller of transferUSDC ----------

/** The unified settlement entry points. Nothing else may call the adapter's transfer. */
const TRANSFER_CALLERS = ["src/workflows/settlement.ts", "src/tabs/ledger.ts"];

describe("(e) only the unified settlement entry points call adapter.transferUSDC", () => {
  it("the call-site scanner matches a call and not a definition or a comment (self-test)", () => {
    const pattern = /\.transferUSDC\(/;
    expect(pattern.test("await adapter.transferUSDC(request)")).toBe(true);
    expect(pattern.test("async transferUSDC(req: TransferRequest)")).toBe(false);
    expect(pattern.test("transferUSDC is not called here")).toBe(false);
  });

  it("only src/workflows/settlement.ts and src/tabs/ledger.ts contain a call", () => {
    const callers = PRODUCT_FILES.filter((f) => /\.transferUSDC\(/.test(readRel(f))).sort();
    expect(callers).toEqual([...TRANSFER_CALLERS].sort());
  });
});
