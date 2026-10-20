import { describe, it, expect } from "vitest";
import path from "node:path";
import { isDirectRun } from "../../src/db/migrate.js";

/**
 * The migration CLI runs only when migrate itself is the program: `node dist/db/migrate.js` (npm run db:migrate) and
 * `tsx src/db/migrate.ts` (npm run db:migrate:dev). An import from the server or the tests must not migrate.
 */
describe("isDirectRun (the migration CLI entry point)", () => {
  it("is true for the compiled file and for the source file, when that file is the program", () => {
    const compiled = path.resolve("dist/db/migrate.js");
    const source = path.resolve("src/db/migrate.ts");
    expect(isDirectRun(compiled, compiled)).toBe(true);
    expect(isDirectRun(source, source)).toBe(true);
  });

  it("is false when another program imports it, or when there is no program name", () => {
    const migrate = path.resolve("dist/db/migrate.js");
    expect(isDirectRun(path.resolve("dist/index.js"), migrate)).toBe(false);
    expect(isDirectRun(path.resolve("node_modules/vitest/vitest.mjs"), path.resolve("src/db/migrate.ts"))).toBe(false);
    expect(isDirectRun(undefined, migrate)).toBe(false);
  });
});
