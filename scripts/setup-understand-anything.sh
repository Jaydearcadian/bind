#!/usr/bin/env bash
# Installs Understand-Anything at the exact commit reviewed for Bind (docs/decisions/0007).
#
# Default: fetch the pinned commit, install from the frozen lockfile, and build the core package
# into $UA_DIR (outside this repo). Nothing is written to your home directory or this repo.
#
# --link: also link the plugin root to ~/.understand-anything-plugin (where the skills look for it)
#         and link the nine skills into ./.claude/skills so Claude Code can load them.
#
# The upstream install.sh is deliberately not used: it follows `main` instead of the reviewed commit.
set -euo pipefail

PIN="f2d0164f72fe678805c34245a6df36acededfebd"
REPO_URL="https://github.com/Egonex-AI/Understand-Anything.git"
UA_DIR="${UA_DIR:-$HOME/.understand-anything/repo}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$UA_DIR/understand-anything-plugin"

command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required (corepack enable pnpm)" >&2; exit 1; }

if [ ! -d "$UA_DIR/.git" ]; then
  mkdir -p "$UA_DIR"
  git -C "$UA_DIR" init -q
  git -C "$UA_DIR" remote add origin "$REPO_URL"
fi
if [ "$(git -C "$UA_DIR" rev-parse HEAD 2>/dev/null || true)" != "$PIN" ]; then
  git -C "$UA_DIR" fetch --depth 1 origin "$PIN"
  git -C "$UA_DIR" checkout -q --detach FETCH_HEAD
fi
test "$(git -C "$UA_DIR" rev-parse HEAD)" = "$PIN" || { echo "checkout is not at the pinned commit" >&2; exit 1; }

# Build scripts run only for the packages the upstream workspace allow-lists (tree-sitter grammars, esbuild, sharp).
(cd "$UA_DIR" && pnpm install --frozen-lockfile)
test -d "$PLUGIN/packages/core/dist" || { echo "core build output missing" >&2; exit 1; }
echo "Understand-Anything $PIN installed at $UA_DIR"

if [ "${1:-}" = "--link" ]; then
  [ -e "$HOME/.understand-anything-plugin" ] || ln -s "$PLUGIN" "$HOME/.understand-anything-plugin"
  mkdir -p "$ROOT/.claude/skills"
  for d in "$PLUGIN"/skills/*/; do
    ln -sfn "$d" "$ROOT/.claude/skills/$(basename "$d")"
  done
  echo "Linked plugin root and skills. Restart Claude Code to load them."
fi
