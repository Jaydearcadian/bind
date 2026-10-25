/**
 * Source-scan guard for docs/decisions/0085: no model-facing tool moves value.
 *
 * Value moves only in the settlement adapters (src/adapters/settlement/), through the effects ledger and the commitment
 * gate. A model-facing tool may read, make an external request that creates no commitment, or call the deterministic
 * commitment path. This test reads source and template files with fs (no network, no process, no model). It is a text
 * scan: it does not parse the TypeScript program, and string concatenation or other obfuscation is beyond it.
 *
 * Checks:
 *   (a) value-moving primitives appear only in src/adapters/settlement/ (or a listed operator script, with a reason);
 *       templates never tell an agent to run a wallet command;
 *   (b) a file under src/agents/ imports no value-moving module;
 *   (c) every model-facing tool is registered in the reviewed TOOL_ALLOWLIST, the tool-registration forms are closed (no
 *       aliases, constructors, methods or extra registration calls), and a commitment tool's handler calls the gate;
 *   (d) no home-directory agent skills, and a deep agent loads only the virtual /skills/ folder;
 *   (e) only the unified settlement entry points call adapter.transferUSDC, with no re-export of the settlement adapter.
 * Comments are removed before the code checks run. Each check has a self-test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------- file helpers ----------

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const TEMPLATE_EXTENSIONS = new Set([".md", ".ts", ".json", ".txt"]);

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

const rawCache = new Map<string, string>();
function readRel(relPath: string): string {
  let text = rawCache.get(relPath);
  if (text === undefined) {
    text = readFileSync(join(ROOT, relPath), "utf8");
    rawCache.set(relPath, text);
  }
  return text;
}

/**
 * The file with its comments removed, so a word in a comment is never a finding. String literals are kept (a primitive
 * named in a string is still a finding). Newlines are kept so that line numbers stay right.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "'" || c === '"' || c === "`") {
      // ' and " strings end at a newline, so a stray quote cannot hide the code after it. Template literals may span lines.
      out += c;
      i++;
      while (i < n && src[i] !== c && !(c !== "`" && src[i] === "\n")) {
        if (src[i] === "\\" && i + 1 < n) {
          out += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      if (i < n && src[i] === c) {
        out += c;
        i++;
      }
      continue;
    }
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const strippedCache = new Map<string, string>();
function codeRel(relPath: string): string {
  let text = strippedCache.get(relPath);
  if (text === undefined) {
    text = stripComments(readRel(relPath));
    strippedCache.set(relPath, text);
  }
  return text;
}

/** 1-based line number of an index in a string. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

const SRC_FILES = walk(join(ROOT, "src"), (n) => CODE_EXTENSIONS.has(extname(n))).map(rel).sort();
const MCP_FILES = walk(join(ROOT, "mcp", "src"), (n) => CODE_EXTENSIONS.has(extname(n))).map(rel).sort();
const SCRIPT_FILES = walk(join(ROOT, "scripts"), (n) => CODE_EXTENSIONS.has(extname(n))).map(rel).sort();
const PRODUCT_FILES = [...SRC_FILES, ...MCP_FILES];
const CODE_FILES = [...PRODUCT_FILES, ...SCRIPT_FILES];
const TEMPLATE_FILES = walk(join(ROOT, "templates"), (n) => TEMPLATE_EXTENSIONS.has(extname(n))).map(rel).sort();

function isSettlementAdapter(relPath: string): boolean {
  return relPath.startsWith("src/adapters/settlement/");
}

// ---------- (a) value-moving primitives ----------

/** Text that sends a transaction, moves value or drives a wallet. Checked on code with comments removed. */
const VALUE_MOVING_PRIMITIVES: Array<{ name: string; pattern: RegExp }> = [
  { name: "writeContract(", pattern: /writeContract\s*\(/ },
  { name: "deployContract(", pattern: /deployContract\s*\(/ },
  { name: "sendTransaction(", pattern: /sendTransaction\s*\(/ },
  { name: "sendRawTransaction", pattern: /sendRawTransaction/ },
  { name: "walletClient", pattern: /walletClient/ },
  { name: "circle wallet", pattern: /\bcircle\s+wallet\b/i },
  { name: "wallet execute", pattern: /\bwallet\s+execute\b/i },
  { name: "child_process exec/spawn of circle", pattern: /\b(exec|execFile|execSync|execFileSync|spawn|spawnSync|fork)\s*\(\s*["'`]circle\b/ },
  { name: "cast send", pattern: /\bcast\s+send\b/ },
  { name: "cast send argument list", pattern: /["'`]cast["'`]\s*,\s*\[\s*["'`]send\b/ },
];

/**
 * Operator scripts and their reason for a primitive. The live harnesses drive the real adapter or a real node on purpose;
 * they are not imported by product code (checked in (b)/(c)/(e) and by the child-process rule below).
 */
const PRIMITIVE_EXCEPTIONS: Record<string, string> = {
  "scripts/live-recovery-arc.ts":
    "Live recovery harness. Its viem transport forwards eth_sendRawTransaction to the real node in a timeout scenario, " +
    "and it drives the real settlement adapter. Operator code, not product code; not imported by src/ or mcp/.",
};

/** Words the templates must never contain (agents read them as instructions). Checked on the raw text. */
const TEMPLATE_FORBIDDEN_WORDS: RegExp[] = [/wallet\s+execute/i, /circle\s+wallet/i];

describe("(a) value-moving primitives stay in the settlement adapters, and templates never instruct a wallet command", () => {
  it("the scanner matches the text it guards, and ignores a comment (self-test)", () => {
    const samples: Array<[string, string]> = [
      ["writeContract(", "await walletClient.writeContract({ address })"],
      ["writeContract(", "await c.writeContract (  { address })"],
      ["deployContract(", "await walletClient.deployContract({ abi })"],
      ["sendTransaction(", "await client.sendTransaction({ to })"],
      ["sendRawTransaction", "eth_sendRawTransaction"],
      ["walletClient", "const walletClient = createWalletClient()"],
      ["circle wallet", "run circle wallet execute now"],
      ["circle wallet", "run Circle\nwallet now"],
      ["wallet execute", "args: ['wallet execute', 'x']"],
      ["wallet execute", "args: ['wallet\texecute', 'x']"],
      ["child_process exec/spawn of circle", 'this.exec("circle", args, { timeout })'],
      ["child_process exec/spawn of circle", 'execFile(\n  "circle",\n  args)'],
      ["cast send", 'execFile("cast send 0x1")'],
      ["cast send argument list", 'spawn("cast", ["send", "0x1"])'],
    ];
    for (const [name, text] of samples) {
      const primitive = VALUE_MOVING_PRIMITIVES.find((p) => p.name === name);
      expect(primitive, `no primitive named ${name}`).toBeDefined();
      expect(primitive!.pattern.test(text), `${name} does not match: ${text}`).toBe(true);
    }
    // A read through the same helper is not a primitive: only the exec-of-circle form matches, and that form is what
    // the one reviewed read-only exception would need. None is listed now, so this read would be a finding.
    const readOnly = 'this.exec("contract", ["query"])';
    expect(VALUE_MOVING_PRIMITIVES.some((p) => p.pattern.test(readOnly))).toBe(false);
    // A comment is not code.
    expect(stripComments("// writeContract(\nconst a = 1; /* walletClient */")).not.toMatch(/writeContract|walletClient/);
    // A string that looks like a comment is kept.
    expect(stripComments('const u = "https://example.test/x";')).toContain("https://example.test/x");
    // A stray quote does not hide the next line.
    expect(stripComments("const q = \"abc\nwriteContract(x)")).toContain("writeContract(x)");
  });

  it("the settlement adapter does contain the primitives, so the scan is not vacuous", () => {
    const arc = codeRel("src/adapters/settlement/arc-l1.ts");
    expect(arc).toMatch(/writeContract\s*\(/);
    expect(arc).toMatch(/walletClient/);
  });

  it("no code file outside src/adapters/settlement/ contains a value-moving primitive", () => {
    const violations: string[] = [];
    for (const file of CODE_FILES) {
      if (isSettlementAdapter(file)) continue;
      if (PRIMITIVE_EXCEPTIONS[file]) continue;
      const text = codeRel(file);
      for (const { name, pattern } of VALUE_MOVING_PRIMITIVES) {
        const match = pattern.exec(text);
        if (match) violations.push(`${file}:${lineOf(text, match.index)} contains "${name}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("each primitive exception is justified and still needed (no stale exception)", () => {
    for (const [file, reason] of Object.entries(PRIMITIVE_EXCEPTIONS)) {
      expect(reason.length, `exception ${file} needs a reason`).toBeGreaterThan(40);
      expect(CODE_FILES, `exception ${file} no longer exists; remove it`).toContain(file);
      const text = codeRel(file);
      expect(
        VALUE_MOVING_PRIMITIVES.some((p) => p.pattern.test(text)),
        `exception ${file} matches no primitive any more; remove it`
      ).toBe(true);
    }
  });

  it("no template tells an agent to run a wallet command (the agents read these as instructions)", () => {
    const violations: string[] = [];
    for (const file of TEMPLATE_FILES) {
      const text = readRel(file);
      for (const word of TEMPLATE_FORBIDDEN_WORDS) {
        const match = word.exec(text);
        if (match) violations.push(`${file}:${lineOf(text, match.index)} contains "${match[0]}"`);
      }
    }
    expect(violations).toEqual([]);
    expect(TEMPLATE_FILES.length).toBeGreaterThan(0);
  });

  it("the template words are matched case-insensitively (self-test)", () => {
    expect(TEMPLATE_FORBIDDEN_WORDS.some((w) => w.test("Run CIRCLE WALLET EXECUTE now"))).toBe(true);
    expect(TEMPLATE_FORBIDDEN_WORDS.some((w) => w.test("Circle Agent Stack is a vendor name"))).toBe(false);
  });
});

// ---------- imports ----------

/** Every module specifier a file imports, requires or dynamically imports. Checked on code with comments removed. */
function importSpecifiers(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

// ---------- (b) src/agents imports ----------

const FORBIDDEN_AGENT_IMPORTS: RegExp[] = [
  /^(node:)?child_process$/,
  /^execa$/,
  /^cross-spawn$/,
  /^viem(\/.*)?$/,
  /(^|\/)adapters\/settlement(\/|$)/,
  /(^|\/)adapters\/circleAgentStack(\.js)?$/,
  /(^|\/)workflows\/settlement(\.js)?$/,
  /(^|\/)tabs\/ledger(\.js)?$/,
];

describe("(b) src/agents never imports a value-moving module", () => {
  const agentFiles = PRODUCT_FILES.filter((f) => f.startsWith("src/agents/"));

  it("the agent folder is scanned and its imports are read", () => {
    expect(agentFiles.length).toBeGreaterThan(0);
    const all = agentFiles.flatMap((f) => importSpecifiers(codeRel(f)));
    expect(all).toContain("@langchain/core/tools");
  });

  it("no file under src/agents imports a settlement, circle, wallet, viem or child-process module", () => {
    const violations: string[] = [];
    for (const file of agentFiles) {
      for (const specifier of importSpecifiers(codeRel(file))) {
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
    expect(matches("viem")).toBe(true);
    expect(matches("../adapters/marketBenchmark.js")).toBe(false);
    expect(matches("../effects/ledger.js")).toBe(false);
    expect(importSpecifiers('const c = require("child_process");')).toContain("child_process");
  });
});

// ---------- child processes (all product code and scripts) ----------

/** Scripts that may spawn a process, each with its reason. Product code has none. */
const CHILD_PROCESS_EXCEPTIONS: Record<string, string> = {
  "scripts/verify-live-arc.ts":
    "Live operator check. Runs `cast call` (a read-only eth_call) for the revert gates (ADR 0077). No `cast send`.",
  "scripts/live-recovery-arc.ts":
    "Live recovery harness. Spawns a child copy of itself with tsx, for the crash-and-restart scenario.",
  "scripts/clean-test-fixtures.ts":
    "Operator cleanup. Runs `git ls-files` to refuse deleting a tracked template directory. No write to the chain.",
};

describe("child processes are confined to listed operator scripts", () => {
  it("no product file imports a process-spawning module", () => {
    const violations: string[] = [];
    for (const file of PRODUCT_FILES) {
      for (const specifier of importSpecifiers(codeRel(file))) {
        if (/^(node:)?child_process$|^execa$|^cross-spawn$/.test(specifier)) violations.push(`${file} imports "${specifier}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("each listed script has a reason, still spawns, and is the only place a spawn is allowed", () => {
    for (const [file, reason] of Object.entries(CHILD_PROCESS_EXCEPTIONS)) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(40);
      expect(CODE_FILES, `${file} no longer exists`).toContain(file);
      expect(importSpecifiers(codeRel(file)).some((s) => /child_process/.test(s)), `${file} no longer spawns`).toBe(true);
    }
    const unlisted = SCRIPT_FILES.filter(
      (f) => !CHILD_PROCESS_EXCEPTIONS[f] && importSpecifiers(codeRel(f)).some((s) => /child_process/.test(s))
    );
    expect(unlisted).toEqual([]);
  });
});

// ---------- (c) the model-facing tool allowlist ----------

/**
 * read = no change to the outside world. internal_write = changes Bind's own database and writes an audit row; no money,
 * no supplier or customer contact. external_request = asks an outside party or a search provider and creates no commitment.
 * commercial_commitment = may bind money or a supplier, and goes through the commitment gate (authorizeCommitment in
 * src/policy/commitment-gate.ts), or through the API route that calls it.
 */
type ToolEffect = "read" | "internal_write" | "external_request" | "commercial_commitment";

interface AllowedTool {
  /** The file that registers the tool. A move to another file is a review. */
  file: string;
  effect: ToolEffect;
  note: string;
}

/** Every model-facing tool, reviewed. Adding one fails the test until it is listed here with its effect class. */
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
    effect: "internal_write",
    note:
      "internal DB write, audited, no money or supplier contact. It sets the workflow's context_data and inserts an audit row " +
      "(the row's effect_class column says commercial_commitment; that label is a known inconsistency, see ADR 0085).",
  },
  request_policy_evaluation: {
    file: "src/agents/replenishmentTools.ts",
    effect: "commercial_commitment",
    note:
      "Runs authorizeCommitment (threshold, budget, pause, approval); only the gate decides. The owner notification uses the " +
      "effects ledger (ADR 0020). It also writes the anti-drift files and may make an external benchmark request " +
      "(allowExternal is false for a demo workspace, ADR 0057).",
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
    note: "Returns the quotes and the market benchmark that generateVerifiableDecisionRecord already holds. Makes no call itself.",
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

/** The one file that may call the MCP server's tool registration. */
const REGISTER_TOOL_FILE = "mcp/src/server.ts";

describe("(c) every model-facing tool is on the reviewed allowlist, and the registration forms are closed", () => {
  it("the language's tool import is exactly `import { tool } from \"@langchain/core/tools\"` (no alias, namespace or require)", () => {
    const valid = /^import\s*\{\s*tool\s*\}\s*from\s*["']@langchain\/core\/tools["'];?/gm;
    const violations: string[] = [];
    for (const file of PRODUCT_FILES) {
      const text = codeRel(file);
      const mentions = [...text.matchAll(/@langchain\/core\/tools/g)].length;
      const plain = [...text.matchAll(valid)].length;
      if (mentions !== plain) violations.push(`${file}: ${mentions - plain} import(s) of @langchain/core/tools are not the plain form`);
      if (/\btool\s+as\s+\w+/.test(text)) violations.push(`${file}: a tool alias (tool as X)`);
    }
    expect(violations).toEqual([]);
  });

  it("no other tool-making form: constructors, methods, DynamicTool, or a registration call outside the MCP server", () => {
    const forbidden: Array<[string, RegExp]> = [
      ["new ...Tool(", /\bnew\s+[A-Za-z_$][\w$]*Tool\s*\(/],
      ["DynamicTool / DynamicStructuredTool / StructuredTool", /\b(DynamicTool|DynamicStructuredTool|StructuredTool)\b/],
      ["a .tool( method call", /\.\s*tool\s*\(/],
      ["registerTool(", /\bregisterTool\s*\(/],
    ];
    const violations: string[] = [];
    for (const file of PRODUCT_FILES) {
      const text = codeRel(file);
      for (const [name, pattern] of forbidden) {
        if (name === "registerTool(" && file === REGISTER_TOOL_FILE) continue;
        const match = pattern.exec(text);
        if (match) violations.push(`${file}:${lineOf(text, match.index)} uses ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the registration forms are the ones the scanner knows (self-test)", () => {
    expect(/\bnew\s+[A-Za-z_$][\w$]*Tool\s*\(/.test("new DynamicStructuredTool({ name })")).toBe(true);
    expect(/\.\s*tool\s*\(/.test("registry.tool(x)")).toBe(true);
    expect(/\bregisterTool\s*\(/.test("server.registerTool('x', {})")).toBe(true);
    expect(/(?<![\w.$])tool\s*\(/.test("const a = tool(async () => 1, {})")).toBe(true);
    expect(/(?<![\w.$])tool\s*\(/.test("const a = myTool(x)")).toBe(false);
    const alias = 'import { tool as t } from "@langchain/core/tools";';
    expect(/\btool\s+as\s+\w+/.test(alias)).toBe(true);
  });

  interface ToolSite {
    file: string;
    line: number;
    name: string | undefined;
    start: number;
    end: number;
  }

  /**
   * Finds each tool registration: `tool(` in src (and in mcp), or the MCP `read(` helper in mcp. The name is the first
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
      return { file, line: lineOf(text, start), name: named?.[1], start, end };
    });
  }

  function allToolSites(): ToolSite[] {
    const files = PRODUCT_FILES.filter((f) => f.startsWith("src/") || f.startsWith("mcp/src/"));
    return files.flatMap((f) => toolSites(f, codeRel(f)));
  }

  it("the tool scanner finds the registrations it should (self-test)", () => {
    const sample = [
      'const a = tool(\n  async ({ x }) => JSON.stringify(x),\n  {\n    name: "sample_read",\n    schema: z.object({}),\n  }\n);',
      'const b = tool(async () => "", { name: "sample_two", schema: z.object({}) });',
      "// const c = tool(async () => 1, { name: \"commented_out\" });",
    ].join("\n");
    const sites = toolSites("src/agents/sample.ts", stripComments(sample));
    expect(sites.map((s) => s.name)).toEqual(["sample_read", "sample_two"]);
    expect(sites[0].line).toBe(1);
  });

  it("every registration has a literal name (none is skipped silently)", () => {
    expect(allToolSites().filter((s) => s.name === undefined)).toEqual([]);
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

  it("every allowlisted tool is registered once, in the file it is listed for", () => {
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

  it("every allowlisted tool has an effect class from the vocabulary and a note", () => {
    const valid = new Set<ToolEffect>(["read", "internal_write", "external_request", "commercial_commitment"]);
    for (const [name, entry] of Object.entries(TOOL_ALLOWLIST)) {
      expect(valid.has(entry.effect), `${name} has no effect class`).toBe(true);
      expect(entry.note.length, `${name} needs a note`).toBeGreaterThan(10);
    }
  });

  it("the commitment tool's own handler calls authorizeCommitment (comments removed, not just somewhere in the file)", () => {
    const commitments = Object.entries(TOOL_ALLOWLIST).filter(
      ([, t]) => t.effect === "commercial_commitment" && t.file.startsWith("src/")
    );
    expect(commitments.map(([n]) => n)).toEqual(["request_policy_evaluation"]);
    for (const [name, entry] of commitments) {
      const site = allToolSites().find((s) => s.name === name);
      expect(site, `${name} is not registered`).toBeDefined();
      const handler = codeRel(entry.file).slice(site!.start, site!.end);
      expect(handler, `${name}'s handler does not call authorizeCommitment(`).toMatch(/\bauthorizeCommitment\s*\(/);
      expect(codeRel(entry.file), `${name}'s file does not import the commitment gate`).toMatch(
        /from\s*["'][^"']*policy\/commitment-gate(\.js)?["']/
      );
    }
  });

  it("the MCP never touches the database or the policy code itself (its commitments are decided by the API)", () => {
    const violations: string[] = [];
    for (const file of MCP_FILES) {
      for (const specifier of importSpecifiers(codeRel(file))) {
        if (specifier === "pg" || specifier.startsWith("pg/")) violations.push(`${file} imports "${specifier}"`);
        if (/(^|\/)src\/(db|policy|workflows|tabs|adapters|effects)\//.test(specifier)) violations.push(`${file} imports "${specifier}"`);
        if (/^\.\.\/\.\.\/src\//.test(specifier)) violations.push(`${file} imports "${specifier}"`);
      }
    }
    expect(violations).toEqual([]);
  });
});

// ---------- (d) no home-directory skills ----------

describe("(d) agents load only Bind's own virtual skills, never a home-directory folder", () => {
  it("no file under src/, scripts/ or templates/ combines os.homedir() with the .agents folder", () => {
    const violations: string[] = [];
    for (const file of [...SRC_FILES, ...SCRIPT_FILES, ...TEMPLATE_FILES]) {
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
      const text = codeRel(file);
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

  it("every deep agent uses a FilesystemBackend, never a sandbox (deepagents' execute tool is a shell on a sandbox backend)", () => {
    // deepagents 1.15 registers an `execute` tool. It refuses unless the backend implements SandboxBackendProtocol, and
    // FilesystemBackend does not. A future sandbox backend would turn the agent's shell on, so this pins the backend.
    const violations: string[] = [];
    let agents = 0;
    for (const file of CODE_FILES) {
      const text = codeRel(file);
      if (!/createDeepAgent\s*\(/.test(text)) continue;
      agents++;
      if (!/new\s+FilesystemBackend\s*\(/.test(text)) violations.push(`${file} creates a deep agent without a FilesystemBackend`);
      if (/Sandbox|\bexecute\s*:\s*true|\bexecute\b\s*\(\s*["'`]/.test(text)) violations.push(`${file} references a sandbox or execute`);
    }
    expect(agents).toBeGreaterThan(0);
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

/** Operator scripts that touch transferUSDC, each with its reason. */
const TRANSFER_EXCEPTIONS: Record<string, string> = {
  "scripts/live-recovery-arc.ts":
    "Live recovery harness. Wraps the real adapter's transferUSDC to count and time the calls it makes. Operator code only.",
};

const TRANSFER_IDENTIFIER = /\btransferUSDC\b/;

describe("(e) only the unified settlement entry points call adapter.transferUSDC, and nothing re-exports the adapter", () => {
  it("the scanner matches a call, a bracket access and an optional call, and ignores a comment (self-test)", () => {
    expect(TRANSFER_IDENTIFIER.test("await adapter.transferUSDC(request)")).toBe(true);
    expect(TRANSFER_IDENTIFIER.test("await adapter?.transferUSDC?.(request)")).toBe(true);
    expect(TRANSFER_IDENTIFIER.test('adapter["transferUSDC"](request)')).toBe(true);
    expect(TRANSFER_IDENTIFIER.test("const f = adapter.transferUSDC.bind(adapter)")).toBe(true);
    expect(TRANSFER_IDENTIFIER.test(stripComments("// transferUSDC is not called here"))).toBe(false);
  });

  it("outside the settlement adapter, only the two entry points and listed scripts mention transferUSDC", () => {
    const violations: string[] = [];
    for (const file of CODE_FILES) {
      if (isSettlementAdapter(file)) continue;
      const text = codeRel(file);
      const match = TRANSFER_IDENTIFIER.exec(text);
      if (!match) continue;
      if (TRANSFER_CALLERS.includes(file) || TRANSFER_EXCEPTIONS[file]) continue;
      violations.push(`${file}:${lineOf(text, match.index)} mentions transferUSDC`);
    }
    expect(violations).toEqual([]);
  });

  it("the two entry points really call it, and every other caller is a listed exception", () => {
    for (const file of TRANSFER_CALLERS) {
      expect(codeRel(file), `${file} no longer calls transferUSDC`).toMatch(/\.transferUSDC\s*\(/);
    }
    for (const [file, reason] of Object.entries(TRANSFER_EXCEPTIONS)) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(40);
      expect(CODE_FILES, `${file} no longer exists`).toContain(file);
    }
  });

  it("no file outside the settlement adapter re-exports from it (re-export laundering)", () => {
    const violations: string[] = [];
    for (const file of CODE_FILES) {
      if (isSettlementAdapter(file)) continue;
      const text = codeRel(file);
      for (const match of text.matchAll(/\bexport\b[^;]*?\bfrom\s*["'][^"']*adapters\/settlement[^"']*["']/g)) {
        violations.push(`${file}:${lineOf(text, match.index!)} re-exports from the settlement adapter`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the re-export rule matches a re-export and not an ordinary import (self-test)", () => {
    const re = /\bexport\b[^;]*?\bfrom\s*["'][^"']*adapters\/settlement[^"']*["']/;
    expect(re.test('export { ArcL1SettlementAdapter } from "../adapters/settlement/arc-l1.js";')).toBe(true);
    expect(re.test('export * from "../adapters/settlement/index.js";')).toBe(true);
    expect(re.test('import { ArcL1SettlementAdapter } from "../adapters/settlement/arc-l1.js";')).toBe(false);
  });
});
