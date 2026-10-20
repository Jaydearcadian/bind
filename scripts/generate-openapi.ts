/**
 * Writes docs/openapi.json from the route registry (docs/decisions/0034). CI runs `npm run api:spec` and then
 * `git diff --exit-code docs/openapi.json`: a stale committed document fails the build.
 *
 * Usage: npm run api:spec
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument, serializeOpenApiDocument, API_VERSION } from "../src/api/openapi.js";
import { ROUTES } from "../src/api/registry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "docs", "openapi.json");

fs.writeFileSync(target, serializeOpenApiDocument(buildOpenApiDocument(ROUTES, API_VERSION)));
console.log(`wrote ${path.relative(root, target)} from ${ROUTES.length} registry entries`);
