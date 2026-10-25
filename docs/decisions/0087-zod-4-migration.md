# ADR 0087: Move from zod 3 to zod 4 for the high-severity audit (GHSA-mrhx-c7xc-m3w5)

## Status
Accepted (2026-10-25). One part is a deliberate exception to the rule we set for dependency overrides (decision 4). It is
reversible, and the owner can reject it with a one-line change.

## Context

`npm audit --audit-level=high` failed. Advisory GHSA-mrhx-c7xc-m3w5: zod before 4.6.6 can exhaust memory validating oversized
constrained collections. There is no 3.x fix. Our direct dependency was `zod ^3.24.1` (3.25.76). Transitive packages that
pinned zod 3 were `@privy-io/api-base` (hard dependency `^3.25.76`, also in its latest release 1.12.0) and our direct
`zod-to-json-schema@3.24.6` (peer `^3.24.1`). `zod-to-json-schema` produces the OpenAPI document (`docs/openapi.json`) and the SDK
types are generated from it.

## Decision

1. **Direct `zod` moves to `^4.6.7`, and our code uses the zod 4 engine.** We did not use the `zod/v3` compatibility subpath
   that zod 4 ships. It keeps the old API, but it still runs the same full-array scan that the advisory describes. Measured on
   zod 4.6.7 with an array of 2,000,000 strings against `.max(200)`: the native engine rejects in 1 ms with no heap growth, while
   `zod/v3` takes 516 ms and 176 MB. The vulnerable 4.6.5 native engine took 45 ms with 16 MB. A `zod/v3` import would have kept
   the pattern the advisory is about on our request validation path.

2. **`zod-to-json-schema` is removed as our direct dependency.** It cannot read zod 4 schemas: every schema in the generated
   document came out as `{}` (10,151 lines lost). The OpenAPI document is now made by `z.toJSONSchema` (target `openapi-3.0`,
   `io: "input"`), with one override in `src/api/openapi.ts` (`matchPreviousDocument`) that writes the same shapes the document
   had before. The regenerated document differs from HEAD in two hunks only, both for `contactEmail` (decision 6). The SDK type
   for `contactEmail` changes accordingly. `docs/capabilities.json` is unchanged.

3. **The offset date-time rule is written out (`src/api/isoDateTime.ts`).** zod 4's `datetime` refuses `2026-01-01T10:00Z` (no
   seconds) and `+0530` (no colon in the offset), which zod 3 accepted. The helper reproduces zod 3's expression exactly and
   has a fixed truth table, recorded from zod 3.25.76, in `tests/unit/zod-4-migration.test.ts`. The MCP source may not import
   server code (`tests/unit/mcp.test.ts`), so `mcp/src/isoDateTime.ts` carries the same expression, and a test checks that the
   two are identical.

4. **Exception to the override rule: `@privy-io/api-base` is overridden to zod `^4.6.7`.** Our rule allows an override only
   where the package's declared range accepts zod 4. Privy's range does not (1.11.0 and 1.12.0 both require `^3.25.76`), so this
   goes beyond that rule, and we say so here. The evidence that it is safe:
   - The privy SDK (`@privy-io/js-sdk-core`, bundled into `web/app/vendor/privy.js`) imports only `PrivyErrorCode` from
     `api-base`. The only zod code in `api-base` is one object schema (`APIError`) built at import time. Nothing in the SDK
     parses with it.
   - On the same inputs, the `APIError` schema built with zod 3.25.76 and with zod 4.6.7 gives identical results.
   - `npm audit` needs zod 3 gone from the tree, and no privy release accepts zod 4, so the override is the only way to pass
     the gate without an allowlist.
   To revert: delete the `overrides` entry for `@privy-io/api-base`, then `npm install`. The audit goes back to failing until
   privy releases a zod 4 build.

5. **Email validation uses `z.email()`.** It accepts and refuses the same values as zod 3's `.email()` on 41 samples. The
   sample table, with zod 3's answers, is in `tests/unit/zod-4-migration.test.ts`. The OpenAPI document keeps `format: email`.

6. **Other zod 4 changes that keep behaviour:**
   - Single-argument `z.record(v)` becomes `z.record(z.string(), v)` (the key was always a string).
   - MCP tool inputs use `typeErrors()` (zod 3's `required_error`/`invalid_type_error` texts and "Required"),
     `closedObject()` (zod 3's `.strict(message)`), and `check(...)` (a `when` guard, so a length or range check runs only on a
     value of its own type). Measured with the MCP SDK's own message format: 436 generated inputs across the 17 tools, and the
     text matches zod 3 except for the non-finite numbers in decision 7.
   - The HTTP `fields` of a 400 come from `validationFields()` (`src/server/errors.ts`). zod 4 also runs a length check on a
     wrong-typed value (an empty array given for a string with `min(1)`), where zod 3 stopped at the type error. A field with a
     type error is now named once, as before. A field that fails two checks on a right-typed value is still named twice, as
     before (HEAD already did this).
   - The OpenAPI optional-branch shape `anyOf: [{not: {}}, email]` (the old converter's artifact) becomes `anyOf: [email, ""]`.
     The two are equivalent: `not: {}` matches nothing, so the optional branch never matched a value.

7. **Documented behaviour changes (accepted, to review).** Zod 4 refuses two kinds of number that zod 3 accepted:
   - **Integers beyond ±(2^53 − 1)**, for example `budgetDailyLimitCents: 9007199254740992`. JavaScript cannot represent these
     exactly, so accepting one could store a value other than the one sent. Now the request gets 400 and the field is named.
   - **Non-finite numbers**, which JSON reads from `1e400` as `Infinity`. zod 3 accepted them. Now 400, field named.
   In the differential run these were the only HTTP changes: 10 of 1,744 generated inputs across 96 routes. They touch the
   integer fields `budgetDailyLimitCents`, `approvalThresholdCents` and `unitPriceCents`, and the number fields
   `currentQuantity`, `parLevel`, `reorderQuantity`, `priceCents` and `spendingLimitCents`. The `PORT=1e400` environment value
   was also accepted before and is refused now. The MCP differential changes only the same non-finite inputs (4 of 436).
   Tests: `tests/unit/zod-4-migration.test.ts` (the integer and infinity refusals) and
   `tests/integration/zod-4-error-fields.test.ts` (the 400 names the field).

8. **Wording that changed and is not part of a contract.** The environment schema (`src/config/env.ts`) has no custom text for
   most of its checks, so its boot-time messages now read as zod 4 writes them (for example `Too small: expected number to be
   >=5` for `BIND_SESSION_MINUTES=4`, where zod 3 said `Number must be greater than or equal to 5`). These are for the developer,
   not a client. No HTTP response body carries zod text: `publicErrorMessage` returns a fixed text for every `ZodError`. This was
   checked by reading every `safeParse` and `parse` call site. MCP messages keep zod 3's wording (decision 6).

9. **MCP advertised schemas.** The MCP SDK converts input schemas itself: zod 4 schemas go through zod 4's converter
   (draft-7). Compared with HEAD, the advertised schemas (17 tools) differ in two places: the datetime fields carry a `pattern`
   in addition to `format: date-time`, and the discriminated `change` union of `propose_menu_change` is `oneOf` (the variants
   are mutually exclusive by their `type` constant, so this is the correct keyword).

## Not changed
- `.passthrough()`, `.strict()` and `z.nativeEnum` are still zod 4's deprecated but working forms. Replacing them with
  `z.looseObject` and `z.strictObject` is mechanical and can be done later. The MCP helper `closedObject` already uses
  `z.strictObject`.

## Consequences
- Gate: `npm audit --audit-level=high` exits 0 (0 vulnerabilities), with no allowlist and no change to the gate command.
- The OpenAPI document and the SDK types change only for `contactEmail`. Generated output is otherwise identical.
- Future zod upgrades: check the `matchPreviousDocument` rules and the two differential checks described in
  `docs/RELEASE_EVIDENCE.md` section 12.
