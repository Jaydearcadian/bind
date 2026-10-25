#!/usr/bin/env bash
# Runs the local gates for Bind. Each gate prints one labelled section and a PASS, FAIL or BLOCKED line.
#
#   bash scripts/verify-local.sh              run every gate; exit 0 only when none failed or was blocked
#   bash scripts/verify-local.sh --list       print "label<TAB>command" for each gate; executes nothing
#   bash scripts/verify-local.sh --accepted   print the NOT_RUN gates that BIND_ACCEPT_NOT_RUN accepts; executes nothing
#
# BLOCKED means a required tool or gate could not run here. It counts as a failure, and a missing tool is never
# accepted. test:e2e runs the website's browser suite (ADR 0054). It is the one gate that may be recorded as NOT_RUN instead,
# and only when BIND_ACCEPT_NOT_RUN contains test:e2e; it is then reported as NOT_RUN_ACCEPTED, neither a pass nor a failure.
#
# Drift checks (OpenAPI spec, SDK types, CODEBASE_MAP) regenerate a committed file and then run `git diff --exit-code`
# on it. Regenerating is the only file write this script makes. On drift the regenerated file is left in the working
# tree so the diff can be read; the script does not restore it. Either revert it (`git checkout -- <file>`) after fixing
# the source, or commit it when the change is intended.
#
# The Slither invocation is `slither . --fail-medium` in contracts/. It reads contracts/slither.config.json (remaps, and
# lib and test paths excluded). Checked locally with Slither 0.11.6 and solc 0.8.28: it exits 0 on the contract as it is
# (low and informational findings only) and 255 when an arbitrary-send function is added. Without the config, `slither .`
# analysed 0 contracts and exited 0, which would have been a false pass. CI runs crytic/slither-action for the same gate,
# and that action has not run.
#
# Forge steps run in contracts/ (the Bind-owned Foundry workspace, docs/CONTRACT_SCOPE.md).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

E2E_GATE="test:e2e"
CONTRACTS_DIR="$ROOT/contracts"
CONTRACT_SUITE=(npx vitest run tests/unit/contract-artifact.test.ts tests/integration/local-chain.test.ts tests/integration/arc-settlement-evm.test.ts tests/integration/arc-find-transfer.test.ts)
fail=0
pass=0
not_run_accepted=0

gate() { printf '%s\t%s\n' "$1" "$2"; }

list_gates() {
  gate 'clean dependency install' 'npm ci'
  gate 'lint' 'npm run lint'
  gate 'typecheck' 'npm run typecheck'
  gate 'unit' 'npm run test:unit'
  gate 'integration' 'npm run test:integration'
  gate 'contract in-process suite' "${CONTRACT_SUITE[*]}"
  gate 'build' 'npm run build'
  gate 'sdk:build' 'npm run sdk:build'
  gate 'mcp:build' 'npm run mcp:build'
  gate 'audit' 'npm audit --audit-level=high'
  gate 'spec drift' 'npm run api:spec && git diff --exit-code docs/openapi.json'
  gate 'sdk drift' 'npm run sdk:generate && git diff --exit-code sdk/src/generated'
  gate 'map drift' 'npm run map:functions && git diff --exit-code docs/CODEBASE_MAP.md'
  gate 'forge fmt --check' 'forge fmt --check'
  gate 'forge build' 'forge build'
  gate 'forge test -vvv' 'forge test -vvv'
  gate 'forge coverage' 'forge coverage'
  gate 'anvil integration' 'npx vitest run tests/integration/anvil-settlement.test.ts'
  gate 'slither (--fail-medium)' 'slither . --fail-medium'
  gate 'test:e2e' 'npm run test:e2e'
}

# Entries of BIND_ACCEPT_NOT_RUN (comma separated, surrounding spaces ignored) that this script accepts as NOT_RUN.
# Only test:e2e can be accepted. Anything else is ignored with a warning on stderr and the gate still runs.
accepted_gates() {
  local list="${BIND_ACCEPT_NOT_RUN:-}" entry
  set -f
  local IFS=','
  for entry in $list; do
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    [ -z "$entry" ] && continue
    if [ "$entry" = "$E2E_GATE" ]; then
      printf '%s\n' "$entry"
    else
      printf 'WARN: BIND_ACCEPT_NOT_RUN entry "%s" is not an acceptable NOT_RUN gate and is ignored\n' "$entry" >&2
    fi
  done
  set +f
}

e2e_accepted() { accepted_gates 2>/dev/null | grep -qxF "$E2E_GATE"; }

case "${1:-}" in
  --list)
    list_gates
    exit 0
    ;;
  --accepted)
    names="$(accepted_gates | sort -u | paste -sd, -)"
    printf 'accepted_not_run=%s\n' "${names:-none}"
    exit 0
    ;;
  '') ;;
  *)
    printf 'usage: %s [--list|--accepted]\n' "$0" >&2
    exit 2
    ;;
esac

run() {
  local label="$1"; shift
  printf '\n===== %s =====\n' "$label"
  if "$@"; then
    printf 'PASS: %s\n' "$label"
    pass=$((pass+1))
  else
    printf 'FAIL: %s\n' "$label"
    fail=$((fail+1))
  fi
}
block() {
  printf 'BLOCKED: %s\n' "$1"
  fail=$((fail+1))
}
have() { command -v "$1" >/dev/null 2>&1; }

rpc_chain_is_31337() {
  node -e '
    fetch(process.argv[1], { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })
      .then((r) => r.json())
      .then((j) => process.exit(j.result === "0x7a69" ? 0 : 1))
      .catch(() => process.exit(1));
  ' "$1"
}

# The local node binary. ANVIL_BIN overrides it. Otherwise arc-anvil (the Arc-aware build, docs/decisions/0088) is preferred
# when it is on PATH, then plain anvil. Prints the name, or nothing and returns 1 when neither is available.
select_node_binary() {
  if [ -n "${ANVIL_BIN:-}" ]; then printf '%s' "$ANVIL_BIN"; return 0; fi
  if have arc-anvil; then printf '%s' arc-anvil; return 0; fi
  if have anvil; then printf '%s' anvil; return 0; fi
  return 1
}

# Starts a local node on a port of its own (18545 unless ANVIL_PORT is set), runs the Anvil suite against it and stops it.
# The argument is the node binary. The suite is skipped without ANVIL_RPC_URL, so this function sets it.
# With arc-anvil the node runs in Arc mode and ANVIL_EXPECT_ARC=1 is set, so the Arc-specific tests must run and fail if the
# node is not in Arc mode. With plain anvil those tests are reported NOT RUN, and the run does not reproduce Arc behaviour
# (a recorded caveat, not a failure). See docs/decisions/0088.
start_anvil_and_test() {
  local bin="$1" port="${ANVIL_PORT:-18545}" url pid log i status
  local -a node_args
  url="http://127.0.0.1:$port"
  case "$(basename "$bin")" in
    arc-anvil*)
      node_args=(--network arc --chain-id 31337 --host 127.0.0.1 --port "$port")
      export ANVIL_EXPECT_ARC=1
      printf 'INFO: starting %s (Arc mode, --network arc) on %s\n' "$bin" "$url"
      ;;
    *)
      node_args=(--chain-id 31337 --host 127.0.0.1 --port "$port")
      unset ANVIL_EXPECT_ARC
      printf 'INFO: starting %s (plain standard-EVM node) on %s\n' "$bin" "$url"
      printf 'CAVEAT: a plain-anvil run does NOT reproduce Arc behaviour (Arc base fee, native-value rules, system-emitter logs). The Arc-specific tests are NOT RUN here. This is recorded, not a failure. See docs/decisions/0088.\n'
      ;;
  esac
  log="$(mktemp "${TMPDIR:-/tmp}/bind-anvil.XXXXXX")" || return 1
  "$bin" "${node_args[@]}" >"$log" 2>&1 &
  pid=$!
  printf 'INFO: %s started with pid %s; the script stops it by that pid when the suite ends\n' "$bin" "$pid"
  for i in $(seq 1 40); do
    rpc_chain_is_31337 "$url" && break
    sleep 1
  done
  if ! rpc_chain_is_31337 "$url"; then
    printf 'anvil did not answer eth_chainId 31337 on %s. Log follows.\n' "$url"
    cat "$log"
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    rm -f "$log"
    return 1
  fi
  ANVIL_RPC_URL="$url" npx vitest run tests/integration/anvil-settlement.test.ts
  status=$?
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  rm -f "$log"
  return $status
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
    local label="$1" name="$2"
    if has_script "$name"; then
      run "$label" "${PKG[@]}" "$name"
    else
      block "Required package script missing: $name"
    fi
  }

  run_script lint lint
  run_script typecheck typecheck
  if has_script test:unit; then run_script unit test:unit
  elif has_script test; then run_script unit test
  else block 'Required unit-test script missing: define test:unit or test.'; fi
  run_script integration test:integration
  run 'contract in-process suite' "${CONTRACT_SUITE[@]}"
  run_script build build
  run_script sdk:build sdk:build
  run_script mcp:build mcp:build

  if [ -f package-lock.json ] && command -v npm >/dev/null 2>&1; then
    run 'audit' npm audit --audit-level=high
  elif [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
    run 'audit' pnpm audit --audit-level high
  elif [ -f yarn.lock ] && command -v yarn >/dev/null 2>&1; then
    if yarn --version | grep -q '^1\.'; then
      run 'audit' yarn audit --level high
    else
      run 'audit' yarn npm audit --all --recursive --environment production
    fi
  elif [ -f bun.lock ] || [ -f bun.lockb ]; then
    if command -v osv-scanner >/dev/null 2>&1; then
      run 'audit' osv-scanner scan source -r .
    else
      block 'Bun lockfile detected. Configure a lockfile-compatible scanner (for example OSV-Scanner) before release.'
    fi
  else
    block 'No supported lockfile-aware dependency audit path detected.'
  fi

  # Drift checks. Each regenerates a committed file and fails if the committed copy is stale (see the header).
  run 'spec drift' bash -c 'npm run api:spec && git diff --exit-code docs/openapi.json'
  run 'sdk drift' bash -c 'npm run sdk:generate && git diff --exit-code sdk/src/generated'
  run 'map drift' bash -c 'npm run map:functions && git diff --exit-code docs/CODEBASE_MAP.md'
fi

# Contract gates. contracts/foundry.toml is required: BindSettlement is in scope (docs/CONTRACT_SCOPE.md).
if [ ! -f "$CONTRACTS_DIR/foundry.toml" ]; then
  block 'contracts/foundry.toml missing. BindSettlement is in scope (docs/CONTRACT_SCOPE.md), so the Foundry workspace is required.'
else
  if have forge; then
    run 'forge fmt --check' bash -c 'cd "$1" && forge fmt --check' _ "$CONTRACTS_DIR"
    run 'forge build' bash -c 'cd "$1" && forge build' _ "$CONTRACTS_DIR"
    run 'forge test -vvv' bash -c 'cd "$1" && forge test -vvv' _ "$CONTRACTS_DIR"
    run 'forge coverage' bash -c 'cd "$1" && forge coverage' _ "$CONTRACTS_DIR"
  else
    block 'forge not installed (skipped: forge fmt --check, forge build, forge test -vvv, forge coverage)'
  fi

  if [ -n "${ANVIL_RPC_URL:-}" ]; then
    run 'anvil integration' npx vitest run tests/integration/anvil-settlement.test.ts
  elif NODE_BIN="$(select_node_binary)"; then
    run 'anvil integration' start_anvil_and_test "$NODE_BIN"
  else
    block 'anvil not installed (skipped: anvil integration)'
  fi

  if have slither; then
    run 'slither (--fail-medium)' bash -c 'cd "$1" && slither . --fail-medium' _ "$CONTRACTS_DIR"
  else
    block 'slither not installed (skipped: slither (--fail-medium))'
  fi
fi

# Browser E2E: the website in Chromium against the real server (ADR 0054). It runs unless BIND_ACCEPT_NOT_RUN names it.
if e2e_accepted; then
  printf '\n===== test:e2e =====\n'
  printf 'NOT_RUN (accepted by BIND_ACCEPT_NOT_RUN): test:e2e (website browser suite not run, ADR 0054)\n'
  not_run_accepted=$((not_run_accepted+1))
else
  run 'test:e2e' npm run test:e2e
fi

printf '\n===== SUMMARY =====\nPASS=%d FAIL_OR_BLOCKED=%d NOT_RUN_ACCEPTED=%d\n' "$pass" "$fail" "$not_run_accepted"
if [ "$not_run_accepted" -gt 0 ]; then
  printf 'NOT_RUN_ACCEPTED: test:e2e (named in BIND_ACCEPT_NOT_RUN; not run; not counted as a failure)\n'
fi
if [ "$fail" -gt 0 ]; then exit 1; fi
printf 'Every gate that ran passed. NOT_RUN_ACCEPTED gates were not run. This does not prove remote/testnet readiness.\n'
