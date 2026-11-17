#!/usr/bin/env bash
# One R4/A4 run: run.sh <id> <prompt-file>. A real Claude Code agent whose only tools are
# Playwright MCP, attached by CDP to the person's already-running browser on 127.0.0.1:9622.
# Empty cwd outside any repository; no user settings, CLAUDE.md, hooks or other MCP servers.
set -uo pipefail
id=$1 prompt=$(cat "$2") here=$(cd "$(dirname "$0")" && pwd)
out=${R4_OUT:-$here/../../../../tmp/r4/runs}/$id cwd=/tmp/r4cwd/$id
mkdir -p "$out" "$cwd"; out=$(cd "$out" && pwd)
cat > "$out/mcp.json" <<JSON
{"mcpServers":{"playwright":{"command":"/run/current-system/sw/bin/npx","args":["-y","@playwright/mcp@0.0.84","--cdp-endpoint","http://127.0.0.1:9622","--output-dir","$out/mcp"]}}}
JSON
printf '%s\n' "$prompt" > "$out/prompt.txt"
start=$(date +%s)
cd "$cwd" && timeout 1500 /home/eunomia/.local/bin/claude -p "$prompt" \
  --model "${R4_MODEL:-sonnet}" --max-turns "${R4_TURNS:-40}" --max-budget-usd "${R4_BUDGET:-1.50}" \
  --setting-sources "" --mcp-config "$out/mcp.json" --strict-mcp-config --tools "" \
  --allowedTools 'mcp__playwright__*' --no-session-persistence \
  --output-format stream-json --verbose < /dev/null > "$out/stream.jsonl" 2> "$out/err.log"
echo "{\"exit\":$?,\"wallSeconds\":$(( $(date +%s)-start ))}" > "$out/meta.json"
python3 -I "$here/summarize.py" "$out"
