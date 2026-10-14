#!/usr/bin/env bash
set -u

ok=0
warn=0
bad=0

check_required() {
  local cmd="$1" min="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    printf 'PASS  %-12s %s\n' "$cmd" "$("$cmd" --version 2>&1 | head -n 1)"
  else
    printf 'MISS  %-12s %s\n' "$cmd" "$min"
    bad=$((bad+1))
  fi
}
check_optional() {
  local cmd="$1" purpose="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    printf 'PASS  %-12s %s\n' "$cmd" "$("$cmd" --version 2>&1 | head -n 1)"
    ok=$((ok+1))
  else
    printf 'OPT   %-12s %s\n' "$cmd" "$purpose"
    warn=$((warn+1))
  fi
}

printf '\nBind One-Shot Environment Preflight\n\n'
check_required git 'Install Git before proceeding.'
check_required node 'Install an actively supported Node.js LTS release if the repository uses TypeScript/Node.'
check_required npm 'Install npm with Node.js, or adapt the project to its existing package manager.'
check_optional tmux 'Required by AGTX.'
check_optional agtx 'One-shot agent orchestrator; see README.md.'
check_optional capa 'Capability/skill/MCP manager; see README.md.'
check_optional forge 'Foundry contract test runner.'
check_optional anvil 'Foundry local EVM node.'
check_optional docker 'Used only for the provided local PostgreSQL service.'
check_optional revdiff 'Optional human-readable diff annotation tool.'

printf '\nSummary: required-missing=%d optional-available=%d optional-missing=%d\n' "$bad" "$ok" "$warn"
if [ "$bad" -gt 0 ]; then
  printf 'BLOCKED: install the missing required tools or document the applicable alternate stack.\n'
  exit 1
fi
printf 'Preflight passed for the Node/Git baseline. Optional tool gaps must be resolved before their associated gates are claimed.\n'
