import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Checks the local gate runner (scripts/verify-local.sh) and its CI workflow without running the gates.
 * `--list` prints the labelled steps and `--accepted` prints what BIND_ACCEPT_NOT_RUN accepts; neither executes a gate.
 * The workflow is parsed with python3 and PyYAML (both present here and on ubuntu runners); a missing parser fails the test.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "scripts/verify-local.sh");
const WORKFLOW = path.join(ROOT, ".github/workflows/quality-gates.yml");
const TESTING_DOC = path.join(ROOT, "docs/TESTING_AND_RELEASE_GATES.md");

interface Gate {
  label: string;
  command: string;
}

function runScript(args: string[], acceptNotRun?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BIND_ACCEPT_NOT_RUN;
  if (acceptNotRun !== undefined) env.BIND_ACCEPT_NOT_RUN = acceptNotRun;
  const result = spawnSync("bash", [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function listGates(): Gate[] {
  const result = runScript(["--list"]);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [label, command, ...rest] = line.split("\t");
      expect(rest, `--list line has extra tab fields: ${line}`).toEqual([]);
      return { label, command };
    });
}

function acceptedFor(value: string | undefined): string {
  const result = runScript(["--accepted"], value);
  expect(result.status, result.stderr).toBe(0);
  const line = result.stdout.trim().split("\n").pop() ?? "";
  expect(line).toMatch(/^accepted_not_run=/);
  return line.slice("accepted_not_run=".length);
}

function workflowJson(): { text: string; doc: any } {
  const text = fs.readFileSync(WORKFLOW, "utf8");
  const parsed = spawnSync(
    "python3",
    ["-I", "-c", "import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding='utf-8'))))", WORKFLOW],
    { encoding: "utf8" }
  );
  if (parsed.status !== 0) {
    throw new Error(`python3 with PyYAML is required to parse the workflow: ${parsed.stderr}`);
  }
  return { text, doc: JSON.parse(parsed.stdout) };
}

/** Which CI job must carry a gate's command. Contract gates run in `contracts`, everything else in `quality`. */
function jobFor(label: string): "quality" | "contracts" {
  const contract =
    label === "contract in-process suite" || label.startsWith("forge ") || label.startsWith("anvil ") || label.startsWith("slither");
  return contract ? "contracts" : "quality";
}

describe("verify-local.sh gate list", () => {
  it("every gate named in the testing-gates doc has a labelled step", () => {
    const labels = listGates().map((gate) => gate.label);
    const required = [
      "lint",
      "typecheck",
      "unit",
      "integration",
      "build",
      "audit",
      "sdk:build",
      "mcp:build",
      "spec drift",
      "sdk drift",
      "map drift",
      "contract in-process suite",
      "forge fmt --check",
      "forge build",
      "forge test -vvv",
      "forge coverage",
      "anvil integration",
      "slither (--fail-medium)",
      "test:e2e",
    ];
    expect(labels).toEqual(expect.arrayContaining(required));
    expect(new Set(labels).size, "gate labels must be unique").toBe(labels.length);

    // The doc names these contract tools, so the list must carry a step for each of them.
    const doc = fs.readFileSync(TESTING_DOC, "utf8");
    for (const tool of ["Forge", "Anvil", "Slither", "forge coverage"]) {
      expect(doc.toLowerCase(), `doc mentions ${tool}`).toContain(tool.toLowerCase());
    }
  });

  it("every step line is label<TAB>command with no execution side effects", () => {
    const gates = listGates();
    expect(gates.length).toBeGreaterThan(15);
    for (const gate of gates) {
      expect(gate.label.length, gate.label).toBeGreaterThan(0);
      expect(gate.command.length, gate.label).toBeGreaterThan(0);
    }
  });
});

describe("test:e2e acceptance", () => {
  it("test:e2e is accepted only through BIND_ACCEPT_NOT_RUN", () => {
    expect(acceptedFor(undefined)).toBe("none");
    expect(acceptedFor("")).toBe("none");
    expect(acceptedFor("test:e2e")).toBe("test:e2e");
    expect(acceptedFor("test:e2e,")).toBe("test:e2e");
  });

  it("the script runs test:e2e as a gate unless it is accepted, and nothing else is accepted that way", () => {
    const text = fs.readFileSync(SCRIPT, "utf8");
    // The website exists (ADR 0054): the browser suite runs by default, and a skip must be asked for by name.
    expect(text).toContain("run 'test:e2e' npm run test:e2e");
    expect(text).not.toContain("block 'test:e2e");
    expect(text).toContain("NOT_RUN (accepted by BIND_ACCEPT_NOT_RUN): test:e2e (website browser suite not run, ADR 0054)");
    // Exactly one call site asks whether a gate is accepted, and it asks for test:e2e.
    const callSites = text.match(/e2e_accepted\b/g) ?? [];
    expect(callSites.length).toBe(2); // one definition, one call
  });

  it("no other gate can be accepted as not run", () => {
    const others = [
      "lint",
      "typecheck",
      "unit",
      "integration",
      "build",
      "audit",
      "spec drift",
      "contract in-process suite",
      "forge build",
      "forge test -vvv",
      "anvil integration",
      "slither (--fail-medium)",
      "forge",
      "anvil",
      "slither",
      "*",
    ];
    for (const name of others) {
      expect(acceptedFor(name), `BIND_ACCEPT_NOT_RUN=${name}`).toBe("none");
    }
    expect(acceptedFor("lint,unit,test:e2e,forge build")).toBe("test:e2e");
    expect(acceptedFor(" test:e2e , forge test -vvv ")).toBe("test:e2e");
  });

  it("an ignored entry is reported on stderr and does not change the run", () => {
    const result = runScript(["--accepted"], "lint");
    expect(result.stdout.trim()).toBe("accepted_not_run=none");
    expect(result.stderr).toContain('WARN: BIND_ACCEPT_NOT_RUN entry "lint" is not an acceptable NOT_RUN gate and is ignored');
  });
});

describe("forge, anvil and slither are required", () => {
  it("each contract tool has a step in the list and a BLOCKED message when the tool is missing", () => {
    const labels = listGates().map((gate) => gate.label);
    expect(labels.filter((label) => label.startsWith("forge ")).length).toBe(4);
    expect(labels).toContain("anvil integration");
    expect(labels).toContain("slither (--fail-medium)");

    const text = fs.readFileSync(SCRIPT, "utf8");
    for (const tool of ["forge", "anvil", "slither"]) {
      expect(text, `have ${tool} check`).toContain(`have ${tool}`);
      expect(text, `${tool} blocked message`).toContain(`${tool} not installed`);
    }
  });

  it("the script carries no escape hatch for contracts", () => {
    const text = fs.readFileSync(SCRIPT, "utf8");
    expect(text).not.toContain("ALLOW_NO_CONTRACTS");
    expect(text).not.toMatch(/BIND_ACCEPT_NOT_RUN[^\n]*(forge|anvil|slither)/);
  });
});

describe("CI workflow parity", () => {
  it("the workflow runs the same labelled gates as --list", () => {
    const { doc } = workflowJson();
    const jobs = doc.jobs as Record<string, unknown>;
    expect(Object.keys(jobs)).toEqual(expect.arrayContaining(["quality", "contracts", "verify-local"]));
    const jobText = {
      quality: JSON.stringify(jobs.quality),
      contracts: JSON.stringify(jobs.contracts),
    };

    for (const gate of listGates()) {
      if (gate.label === "test:e2e") continue; // covered by the verify-local job below
      if (gate.label === "slither (--fail-medium)") {
        expect(jobText.contracts, "Slither runs through crytic/slither-action in CI").toContain("crytic/slither-action");
        continue;
      }
      const job = jobFor(gate.label);
      for (const part of gate.command.split(" && ")) {
        expect(jobText[job], `${job} job runs "${part}" for gate "${gate.label}"`).toContain(part);
      }
    }
  });

  it("the verify-local job runs the aggregate script with test:e2e accepted and nothing else", () => {
    const { doc } = workflowJson();
    const job = doc.jobs["verify-local"];
    expect(JSON.stringify(job)).toContain("bash scripts/verify-local.sh");
    expect(doc.env?.BIND_ACCEPT_NOT_RUN ?? job.env?.BIND_ACCEPT_NOT_RUN).toBe("test:e2e");
  });

  it("the workflow does not set ALLOW_NO_CONTRACTS", () => {
    const { text } = workflowJson();
    expect(text).not.toContain("ALLOW_NO_CONTRACTS");
  });

  it("the workflow grants a read-only token", () => {
    const { doc } = workflowJson();
    expect(doc.permissions).toEqual({ contents: "read" });
  });
});
