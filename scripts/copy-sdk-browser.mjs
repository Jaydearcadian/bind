#!/usr/bin/env node
// Copies the browser-facing SDK modules (compiled .js only, nested folders kept) from sdk/dist into a target folder.
// Used by vercel.json so that /sdk/index.js exists in the static output (ADR 0056). Source maps and .d.ts files are not
// copied: the static host would otherwise publish them, and the browser does not need them.
//
//   node scripts/copy-sdk-browser.mjs <targetDir>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(ROOT, "sdk", "dist");
const target = process.argv[2];

if (!target) {
  console.error("usage: node scripts/copy-sdk-browser.mjs <targetDir>");
  process.exit(2);
}
if (!fs.existsSync(path.join(source, "index.js"))) {
  console.error(`copy-sdk-browser: ${source}/index.js is missing. Run npm run sdk:build first.`);
  process.exit(1);
}

let copied = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const from = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(from);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      const to = path.join(path.resolve(target), path.relative(source, from));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied += 1;
    }
  }
}
walk(source);
console.log(`copy-sdk-browser: copied ${copied} .js files to ${path.resolve(target)}`);
