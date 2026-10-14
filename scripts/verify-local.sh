#!/usr/bin/env bash
# Runs project commands and intentionally fails on missing required scripts/gates.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail=0
pass=0

run() {
  local label="$1"; shift
  printf '\n===== %s =====\n' "$label"
  if "$@"; then
    printf 'PASS: %s\n' "$label"
    pass=$((pass+1))
  else
    printf 'FAIL: %s\n' "$label"
    fail=$((fail+1))
    return 1
  fi
}
block() {
  printf 'BLOCKED: %s\n' "$1"
  fail=$((fail+1))
}

if [ ! -f package.json ]; then
  block 'No package.json. Adapt this runner to the real stack; do not report an empty repository as tested.'
else
  # Select the manager from the existing lockfile rather than generating a second one.
  if [ -f pnpm-lock.yaml ]; then
    command -v pnpm >/dev/null 2>&1 || { block 'pnpm-lock.yaml exists but pnpm is not installed'; }
    PKG=(pnpm)
    INSTALL=(pnpm install --frozen-lockfile)
  elif [ -f bun.lock ] || [ -f bun.lockb ]; then
    command -v bun >/dev/null 2>&1 || { block 'Bun lockfile exists but bun is not installed'; }
    PKG=(bun run)
    INSTALL=(bun install --frozen-lockfile)
  elif [ -f package-lock.json ]; then
    PKG=(npm run)
    INSTALL=(npm ci)
  elif [ -f yarn.lock ]; then
    command -v yarn >/dev/null 2>&1 || { block 'yarn.lock exists but yarn is not installed'; }
    PKG=(yarn)
    INSTALL=(yarn install --immutable)
  else
    block 'No package-manager lockfile. Generate and commit one before claiming reproducible builds.'
    PKG=(npm run)
    INSTALL=(npm install)
  fi

  if [ -d node_modules ]; then
    printf 'INFO: node_modules already exists; the dependency tree is not proven clean by this run.\n'
  elif [ "${#INSTALL[@]}" -gt 0 ]; then
    run 'clean dependency install' "${INSTALL[@]}"
  fi

  has_script() {
    local name="$1"
    node -e 'const p=require("./package.json"); process.exit(p.scripts && p.scripts[process.argv[1]] ? 0 : 1)' "$name"
  }
  run_script() {
    local name="$1"; shift
    if has_script "$name"; then
      run "$name" "${PKG[@]}" "$name" "$@"
    else
      block "Required package script missing: $name"
    fi
  }

  run_script lint
  run_script typecheck
  if has_script test:unit; then run_script test:unit
  elif has_script test; then run_script test
  else block 'Required unit-test script missing: define test:unit or test.'; fi
  run_script test:integration
  run_script test:e2e
  run_script build

  if [ -f package-lock.json ] && command -v npm >/dev/null 2>&1; then
    run 'dependency audit (high and critical)' npm audit --audit-level=high
  elif [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
    run 'dependency audit (high and critical)' pnpm audit --audit-level high
  elif [ -f yarn.lock ] && command -v yarn >/dev/null 2>&1; then
    if yarn --version | grep -q '^1\.'; then
      run 'dependency audit (high and critical)' yarn audit --level high
    else
      run 'dependency audit (high and critical)' yarn npm audit --all --recursive --environment production
    fi
  elif [ -f bun.lock ] || [ -f bun.lockb ]; then
    if command -v osv-scanner >/dev/null 2>&1; then
      run 'dependency scan' osv-scanner scan source -r .
    else
      block 'Bun lockfile detected. Configure a lockfile-compatible scanner (for example OSV-Scanner) before release.'
    fi
  else
    block 'No supported lockfile-aware dependency audit path detected.'
  fi
fi

# Look for a Foundry workspace without treating absence as an implicit pass.
FOUNDRY_DIR=""
if [ -f foundry.toml ]; then FOUNDRY_DIR="$ROOT";
elif [ -f contracts/foundry.toml ]; then FOUNDRY_DIR="$ROOT/contracts";
fi
if [ -n "$FOUNDRY_DIR" ]; then
  if ! command -v forge >/dev/null 2>&1; then
    block 'Foundry configuration exists but forge is not installed.'
  else
    run 'Forge format check' bash -c 'cd "$1" && forge fmt --check' _ "$FOUNDRY_DIR"
    run 'Forge unit/fuzz/invariant tests' bash -c 'cd "$1" && forge test -vvv' _ "$FOUNDRY_DIR"
    run 'Forge coverage' bash -c 'cd "$1" && forge coverage' _ "$FOUNDRY_DIR"
  fi
elif [ "${ALLOW_NO_CONTRACTS:-0}" = "1" ] && [ -f docs/CONTRACT_SCOPE.md ] && grep -Eq '^Decision:[[:space:]]*NOT_APPLICABLE([[:space:]]|$)' docs/CONTRACT_SCOPE.md; then
  printf '\nNOT_APPLICABLE: no Bind-owned Solidity per docs/CONTRACT_SCOPE.md. Verify the described ABI/client boundary tests are part of the app suites.\n'
else
  block 'No foundry.toml found. Add the real contract suite, or explicitly document why Bind owns no Solidity in docs/CONTRACT_SCOPE.md and rerun with ALLOW_NO_CONTRACTS=1.'
fi

printf '\n===== SUMMARY =====\nPASS=%d FAIL_OR_BLOCKED=%d\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then exit 1; fi
printf 'All configured local gates passed. This does not prove remote/testnet readiness.\n'
