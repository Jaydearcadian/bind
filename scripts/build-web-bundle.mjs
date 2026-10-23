#!/usr/bin/env node
// Bundles the browser-side SDK adapter into web/app/vendor/privy.js (ADR 0071). The site's CSP is script-src 'self' and
// has no CDN, so Privy's SDK is built here and served from our own origin. The output is generated and not committed.
//
//   node scripts/build-web-bundle.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "scripts", "web-entry", "privy.js");
export const WEB_BUNDLE_OUTFILE = path.join(ROOT, "web", "app", "vendor", "privy.js");

/** Builds the bundle and returns its path and size in bytes. Throws on any build error. */
export async function buildWebBundle({ outfile = WEB_BUNDLE_OUTFILE } = {}) {
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await build({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    format: "esm",
    minify: true,
    target: "es2022",
    platform: "browser",
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
    define: {
      "process.env.NODE_ENV": '"production"',
      global: "globalThis",
    },
  });
  return { outfile, bytes: fs.statSync(outfile).size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { outfile, bytes } = await buildWebBundle();
    const kib = (bytes / 1024).toFixed(1);
    console.log(`web bundle: ${path.relative(ROOT, outfile)} ${bytes} bytes (${kib} KiB)`);
  } catch (err) {
    console.error(`web bundle failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
