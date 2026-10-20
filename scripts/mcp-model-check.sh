#!/usr/bin/env bash
# Drives the Bind MCP server with a real model through the `claude` CLI against a local API and a throwaway workspace.
# It is a usability check of the tool surface (ADR 0042), not a pass/fail gate: a model's wording varies run to run.
# Needs: PostgreSQL (DATABASE_URL via .env.local), a built tree (npm run build && npm run mcp:build), the `claude` CLI signed in.
# Everything it creates is deleted on exit. Transcripts are written to the directory printed at the start; they hold no token.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MCP_CHECK_PORT:-3111}"
OUT="$(mktemp -d)"
SERVER_PID=""
WS=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill -TERM "$SERVER_PID" 2>/dev/null
  if [ -n "$WS" ]; then
    DB="$(grep '^DATABASE_URL=' "$REPO/.env.local" | cut -d= -f2-)"
    psql "$DB" -Atc "DELETE FROM workspaces WHERE id='$WS';" >/dev/null 2>&1
  fi
  rm -f "$OUT/mcp.json" "$OUT/creds.json"
}
trap cleanup EXIT
command -v claude >/dev/null || { echo "BLOCKED: the claude CLI is not installed"; exit 2; }
[ -f "$REPO/mcp/dist/mcp/src/main.js" ] && [ -f "$REPO/dist/index.js" ] || { echo "BLOCKED: run npm run build and npm run mcp:build first"; exit 2; }
echo "output directory: $OUT"

cat > "$OUT/setup.mts" <<TS
import { runMigrations } from "$REPO/src/db/migrate.js";
import { provisionWorkspace } from "$REPO/src/templates/registry.js";
import { issueToken } from "$REPO/src/auth/tokens.js";
import { closePool } from "$REPO/src/db/client.js";
await runMigrations();
const ws = "ws-mcpcheck-" + Date.now();
await provisionWorkspace(ws, "MCP Check Kitchen", "kitchen-v1");
const staff = await issueToken(ws, "staff", "mcp-check-staff");
console.log(JSON.stringify({ ws, token: staff.token }));
await closePool();
TS
(cd "$REPO" && npx tsx "$OUT/setup.mts" | tail -1 > "$OUT/creds.json") || { echo "setup failed"; exit 1; }
WS="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).ws)' "$OUT/creds.json")"

(cd "$REPO" && PORT="$PORT" BIND_WORKER_ENABLED=false node dist/index.js > "$OUT/server.log" 2>&1 & echo $! > "$OUT/server.pid")
SERVER_PID="$(cat "$OUT/server.pid")"
for _ in $(seq 1 30); do curl -s -m 1 "localhost:$PORT/ready" | grep -q ready && break; sleep 1; done
curl -s -m 1 "localhost:$PORT/ready" | grep -q ready || { echo "BLOCKED: the API did not become ready"; exit 1; }

node -e '
const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
require("fs").writeFileSync(process.argv[2], JSON.stringify({ mcpServers: { bind: { command: "node",
  args: [process.argv[3] + "/mcp/dist/mcp/src/main.js"], env: { BIND_API_URL: "http://localhost:" + process.argv[4], BIND_API_TOKEN: c.token } } } }), { mode: 0o600 });
' "$OUT/creds.json" "$OUT/mcp.json" "$REPO" "$PORT"

i=0
for prompt in "$REPO"/scripts/mcp-model-check-prompts/*.txt; do
  i=$((i + 1))
  timeout 540 claude -p "$(cat "$prompt")" --mcp-config "$OUT/mcp.json" --strict-mcp-config \
    --allowedTools "mcp__bind__*" --max-turns 30 --output-format json > "$OUT/run$i.json" 2> "$OUT/run$i.err"
  echo "run $i ($(basename "$prompt")): exit=$?"
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("turns="+r.num_turns+" error="+r.is_error);console.log(r.result)' "$OUT/run$i.json"
done
echo "workspace $WS is deleted on exit; transcripts are in $OUT"
