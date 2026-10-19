// Compiles contracts/src/BindSettlement.sol with the pinned solc and writes contracts/artifacts/BindSettlement.json.
// Run through `npm run contract:artifact`. The output is committed; a unit test checks sourceSha256 against the source.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import solc from "solc";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const sourcePath = path.join(repoRoot, "contracts/src/BindSettlement.sol");
const outPath = path.join(repoRoot, "contracts/artifacts/BindSettlement.json");
const sourceKey = "BindSettlement.sol";
const contractName = "BindSettlement";
const evmVersion = "cancun";

const sourceBytes = fs.readFileSync(sourcePath);
const sourceSha256 = crypto.createHash("sha256").update(sourceBytes).digest("hex");

const input = {
  language: "Solidity",
  sources: { [sourceKey]: { content: sourceBytes.toString("utf8") } },
  settings: {
    evmVersion,
    optimizer: { enabled: false },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const diagnostics = output.errors ?? [];
const errors = diagnostics.filter((e) => e.severity === "error");
for (const warning of diagnostics.filter((e) => e.severity !== "error")) {
  process.stderr.write(`${warning.formattedMessage ?? warning.message}\n`);
}
if (errors.length > 0) {
  for (const error of errors) {
    process.stderr.write(`${error.formattedMessage ?? error.message}\n`);
  }
  process.stderr.write(`solc reported ${errors.length} error(s) for ${sourceKey}; no artifact written.\n`);
  process.exit(1);
}

const compiled = output.contracts?.[sourceKey]?.[contractName];
if (!compiled) {
  process.stderr.write(`solc output has no contract ${contractName} in ${sourceKey}; no artifact written.\n`);
  process.exit(1);
}

const artifact = {
  contractName,
  solcVersion: solc.version(),
  evmVersion,
  sourceSha256,
  abi: compiled.abi,
  bytecode: `0x${compiled.evm.bytecode.object}`,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
process.stdout.write(`wrote ${path.relative(repoRoot, outPath)} (solc ${artifact.solcVersion}, sha256 ${sourceSha256})\n`);
