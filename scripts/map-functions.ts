/**
 * Deterministic function-level call graph for the TypeScript sources.
 *
 * Enumerates every function, method, constructor, accessor, named arrow function and Express route
 * handler, resolves calls between them with the TypeScript type checker, and writes
 * docs/CODEBASE_MAP.md plus .ua/function-map.json. Layer names come from the Understand-Anything graph
 * (.ua/knowledge-graph.json) when it exists; otherwise the top-level folder is used.
 *
 * Usage: npx tsx scripts/map-functions.ts
 */
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const ROUTE_VERBS = new Set(["get", "post", "put", "patch", "delete"]);

interface Fn {
  id: string;
  name: string;
  kind: "function" | "method" | "constructor" | "arrow" | "route" | "class" | "module";
  file: string;
  startLine: number;
  endLine: number;
  params: number;
  exported: boolean;
  node: ts.Node;
  calls: Set<string>;
  callers: Set<string>;
  route?: string;
}

const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
if (!configPath) throw new Error("tsconfig.json not found");
const parsed = ts.getParsedCommandLineOfConfigFile(
  configPath,
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  }
);
if (!parsed) throw new Error("could not parse tsconfig.json");
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

const sources = program
  .getSourceFiles()
  .filter((f) => !f.isDeclarationFile && f.fileName.startsWith(root + path.sep) && !f.fileName.includes("node_modules"))
  .sort((a, b) => a.fileName.localeCompare(b.fileName));

const fns: Fn[] = [];
const nodeToFn = new Map<ts.Node, Fn>();

const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
const lineOf = (sf: ts.SourceFile, pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

function hasExport(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function register(sf: ts.SourceFile, node: ts.Node, fn: Omit<Fn, "id" | "file" | "startLine" | "endLine" | "node" | "calls" | "callers">, aliasNodes: ts.Node[] = []): Fn {
  const file = rel(sf.fileName);
  const entry: Fn = {
    ...fn,
    id: `${file}#${fn.name}`,
    file,
    startLine: lineOf(sf, node.getStart(sf)),
    endLine: lineOf(sf, node.getEnd()),
    node,
    calls: new Set(),
    callers: new Set(),
  };
  // Disambiguate duplicate names within a file (overloads, repeated handlers).
  let n = 1;
  const base = entry.id;
  while (fns.some((f) => f.id === entry.id)) entry.id = `${base}~${++n}`;
  fns.push(entry);
  nodeToFn.set(node, entry);
  for (const a of aliasNodes) nodeToFn.set(a, entry);
  return entry;
}

function routeOf(node: ts.Node): string | undefined {
  const call = node.parent;
  if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return undefined;
  const verb = call.expression.name.text;
  if (!ROUTE_VERBS.has(verb)) return undefined;
  const first = call.arguments[0];
  if (!first || !ts.isStringLiteralLike(first)) return undefined;
  return `${verb.toUpperCase()} ${first.text}`;
}

function collect(sf: ts.SourceFile, node: ts.Node, className?: string, classExported = false): void {
  if (ts.isClassDeclaration(node) && node.name) {
    const exported = hasExport(node);
    const hasCtor = node.members.some(ts.isConstructorDeclaration);
    if (!hasCtor) register(sf, node, { name: node.name.text, kind: "class", params: 0, exported });
    node.members.forEach((m) => collect(sf, m, node.name!.text, exported));
    return;
  }
  if (ts.isFunctionDeclaration(node) && node.name && node.body) {
    register(sf, node, { name: node.name.text, kind: "function", params: node.parameters.length, exported: hasExport(node) });
  } else if ((ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) && node.body && className) {
    register(sf, node, { name: `${className}.${node.name.getText(sf)}`, kind: "method", params: node.parameters.length, exported: classExported });
  } else if (ts.isConstructorDeclaration(node) && node.body && className) {
    const entry = register(sf, node, { name: `${className}.constructor`, kind: "constructor", params: node.parameters.length, exported: classExported });
    const cls = node.parent;
    if (ts.isClassDeclaration(cls)) nodeToFn.set(cls, entry);
  } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const route = routeOf(node);
    const p = node.parent;
    if (route) {
      register(sf, node, { name: route, kind: "route", params: node.parameters.length, exported: false, route });
    } else if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
      const stmt = p.parent?.parent;
      register(sf, node, { name: p.name.text, kind: "arrow", params: node.parameters.length, exported: !!stmt && hasExport(stmt) }, [p]);
    } else if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
      register(sf, node, { name: p.name.text, kind: "arrow", params: node.parameters.length, exported: false }, [p]);
    }
  }
  ts.forEachChild(node, (c) => collect(sf, c, className, classExported));
}

for (const sf of sources) collect(sf, sf);

// Interface members map to the class methods that implement them, so a call through an interface
// (for example a SupplierAdapter) reaches every concrete implementation.
const implsOf = new Map<ts.Node, Fn[]>();
for (const fn of [...fns]) {
  if (fn.kind !== "method" || !ts.isMethodDeclaration(fn.node) || !ts.isClassDeclaration(fn.node.parent)) continue;
  const cls = fn.node.parent;
  const memberName = fn.node.name.getText();
  for (const clause of cls.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
    for (const typeNode of clause.types) {
      const prop = checker.getTypeAtLocation(typeNode).getProperty(memberName);
      for (const d of prop?.declarations ?? []) implsOf.set(d, [...(implsOf.get(d) ?? []), fn]);
    }
  }
}

function resolveCallees(expr: ts.Expression): Fn[] {
  const target = ts.isPropertyAccessExpression(expr) ? expr.name : expr;
  let sym = checker.getSymbolAtLocation(target);
  if (!sym) return [];
  if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const hits: Fn[] = [];
  for (const d of sym.declarations ?? []) {
    const direct = nodeToFn.get(d);
    if (direct) hits.push(direct);
    hits.push(...(implsOf.get(d) ?? []));
  }
  return hits;
}

// Code outside any registered function (module top level, test callbacks) belongs to a per-file <module> entry.
function walkCalls(owner: Fn, start: ts.Node): void {
  const visit = (node: ts.Node, top: boolean): void => {
    if (!top && nodeToFn.has(node) && nodeToFn.get(node) !== owner) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      for (const callee of resolveCallees(node.expression)) {
        if (callee !== owner) {
          owner.calls.add(callee.id);
          callee.callers.add(owner.id);
        }
      }
    }
    ts.forEachChild(node, (c) => visit(c, false));
  };
  visit(start, true);
}

for (const fn of [...fns]) {
  const body = (fn.node as ts.FunctionLikeDeclaration).body;
  if (body) walkCalls(fn, body);
}
for (const sf of sources) {
  const mod: Fn = { id: `${rel(sf.fileName)}#<module>`, name: "<module>", kind: "module", file: rel(sf.fileName), startLine: 1, endLine: sf.getLineAndCharacterOfPosition(sf.end).line + 1, params: 0, exported: false, node: sf, calls: new Set(), callers: new Set() };
  walkCalls(mod, sf);
  if (mod.calls.size) fns.push(mod);
}

// Layers from the Understand-Anything graph, when present.
const layerOfFile = new Map<string, string>();
const graphPath = path.join(root, ".ua", "knowledge-graph.json");
if (fs.existsSync(graphPath)) {
  const g = JSON.parse(fs.readFileSync(graphPath, "utf8"));
  const pathOfNode = new Map<string, string>(g.nodes.map((n: any) => [n.id, n.filePath]));
  for (const l of g.layers ?? []) for (const id of l.nodeIds) {
    const p = pathOfNode.get(id);
    if (p) layerOfFile.set(p, l.name);
  }
}
const layerOf = (file: string) => layerOfFile.get(file) ?? (file.startsWith("tests/") ? "Tests" : file.split("/")[0]);

const isTest = (f: Fn) => f.file.startsWith("tests/");
const real = fns.filter((f) => f.kind !== "module");
const prod = real.filter((f) => !isTest(f));
const byId = new Map(fns.map((f) => [f.id, f]));
const prodCallers = (f: Fn) => [...f.callers].filter((id) => !isTest(byId.get(id)!)).length;
const testCallers = (f: Fn) => [...f.callers].filter((id) => isTest(byId.get(id)!)).length;

const mid = new Map(fns.map((f, i) => [f.id, `n${i}`]));
const esc = (s: string) => s.replace(/"/g, "'");

const out: string[] = [];
out.push("# Codebase map: functions and calls", "");
out.push("Generated by `npx tsx scripts/map-functions.ts` from the TypeScript compiler's symbol table. Do not edit by hand.");
out.push("The browser UI (`src/ui`, plain JavaScript) and the Solidity contract are not included here; see `.ua/knowledge-graph.json` for the contract.", "");
out.push(`- Functions, methods, handlers and classes: **${real.length}** (${prod.length} in production code, ${real.length - prod.length} in tests)`);
out.push(`- Resolved call edges: **${fns.reduce((a, f) => a + f.calls.size, 0)}**`);
out.push(`- HTTP routes: **${fns.filter((f) => f.kind === "route").length}**`, "");

// Layer summary
const layerEdges = new Map<string, number>();
for (const f of prod) for (const c of f.calls) {
  const t = byId.get(c)!;
  if (isTest(t)) continue;
  const a = layerOf(f.file), b = layerOf(t.file);
  if (a !== b) layerEdges.set(`${a}\u0000${b}`, (layerEdges.get(`${a}\u0000${b}`) ?? 0) + 1);
}
const layerNames = [...new Set(prod.map((f) => layerOf(f.file)))].sort();
out.push("## Layers and cross-layer calls", "", "```mermaid", "flowchart LR");
layerNames.forEach((l, i) => out.push(`  L${i}["${esc(l)}<br/>${prod.filter((f) => layerOf(f.file) === l).length} fns"]`));
for (const [k, n] of [...layerEdges].sort()) {
  const [a, b] = k.split("\u0000");
  out.push(`  L${layerNames.indexOf(a)} -->|${n}| L${layerNames.indexOf(b)}`);
}
out.push("```", "");

// HTTP surface
const routes = fns.filter((f) => f.kind === "route").sort((a, b) => a.startLine - b.startLine);
out.push("## HTTP surface: route to what it calls", "", "| Route | Line | Calls directly |", "| --- | --- | --- |");
for (const r of routes) {
  const callees = [...r.calls].map((id) => byId.get(id)!).filter((c) => !isTest(c)).map((c) => `\`${c.name}\``);
  out.push(`| \`${r.route}\` | ${r.startLine} | ${callees.length ? callees.join(", ") : "SQL or inline logic only"} |`);
}
out.push("");

// Per layer inventory and diagram
for (const layer of layerNames) {
  const members = prod.filter((f) => layerOf(f.file) === layer && f.kind !== "route");
  if (!members.length) continue;
  out.push(`## ${layer}`, "");
  out.push("| Function | File:lines | Kind | Params | Exported | Called by (prod / tests) | Calls |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const f of members.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine)) {
    out.push(`| \`${f.name}\` | ${f.file}:${f.startLine}-${f.endLine} | ${f.kind} | ${f.params} | ${f.exported ? "yes" : "no"} | ${prodCallers(f)} / ${testCallers(f)} | ${f.calls.size} |`);
  }
  out.push("");
  const inLayer = new Set(members.map((f) => f.id));
  const edges = members.flatMap((f) => [...f.calls].filter((c) => inLayer.has(c)).map((c) => [f.id, c] as const));
  if (edges.length) {
    out.push("```mermaid", "flowchart LR");
    const files = [...new Set(members.map((f) => f.file))];
    files.forEach((file, i) => {
      out.push(`  subgraph F${i}["${file}"]`);
      members.filter((f) => f.file === file).forEach((f) => out.push(`    ${mid.get(f.id)}["${esc(f.name)}"]`));
      out.push("  end");
    });
    for (const [a, b] of edges) out.push(`  ${mid.get(a)} --> ${mid.get(b)}`);
    out.push("```", "");
  }
}

// Wiring report
const unwired = prod.filter((f) => f.kind !== "route" && prodCallers(f) === 0 && f.exported);
out.push("## Exported but never called from production code", "");
out.push("These are exported symbols with no caller in `src/` or `scripts/`. Some are entry points (`main`) or called only from tests, which is the signal that matters.", "");
out.push("| Function | File:line | Called from tests |", "| --- | --- | --- |");
for (const f of unwired.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine)) {
  out.push(`| \`${f.name}\` | ${f.file}:${f.startLine} | ${testCallers(f) > 0 ? "yes" : "no"} |`);
}
out.push("");
const untested = prod.filter((f) => f.kind !== "route" && f.file.startsWith("src/") && testCallers(f) === 0);
out.push("## Production functions with no direct test caller", "", `${untested.length} of ${prod.filter((f) => f.kind !== "route" && f.file.startsWith("src/")).length}. Indirect coverage through other functions is not counted here.`, "");
const perFile = new Map<string, string[]>();
for (const f of untested) perFile.set(f.file, [...(perFile.get(f.file) ?? []), f.name]);
for (const [file, names] of [...perFile].sort()) out.push(`- \`${file}\`: ${names.map((n) => `\`${n}\``).join(", ")}`);
out.push("");

fs.writeFileSync(path.join(root, "docs", "CODEBASE_MAP.md"), out.join("\n"));
fs.mkdirSync(path.join(root, ".ua"), { recursive: true });
fs.writeFileSync(
  path.join(root, ".ua", "function-map.json"),
  JSON.stringify(fns.map((f) => ({ id: f.id, name: f.name, kind: f.kind, file: f.file, startLine: f.startLine, endLine: f.endLine, params: f.params, exported: f.exported, route: f.route, layer: layerOf(f.file), calls: [...f.calls], callers: [...f.callers] })), null, 2)
);
console.log(`functions=${real.length} prod=${prod.length} calls=${fns.reduce((a, f) => a + f.calls.size, 0)} routes=${routes.length} unwiredExported=${unwired.length}`);
