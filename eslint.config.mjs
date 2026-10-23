import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // The credential store returns plaintext secrets (ADR 0024). Routes and model-facing tools reach it only through
    // src/credentials/admin.ts, which does not export getCredentialForAdapter.
    files: ["src/server/**/*.ts", "src/agents/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/credentials/store", "**/credentials/store.js", "**/credentials/store.ts"],
              message:
                "Routes and model-facing tools must not import the credential store (ADR 0024). Import src/credentials/admin.ts instead.",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ["dist/**", "mcp/dist/**", "sdk/dist/**", "node_modules/**", "coverage/**", "artifacts/**", ".agtx/**", ".agents/**", "src/ui/public/**"],
  }
);
