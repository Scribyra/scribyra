#!/usr/bin/env bash
# DRAFT, NOT RUN. Needs approval before use: it spends model usage on the caller's account.
# usage: run-one.sh <arm> <task> <rep>
# The harness first launches Chromium on port 9592, imports the fixture and opens the tabs.
# Auth comes from ANTHROPIC_API_KEY (capped key) or CLAUDE_CODE_OAUTH_TOKEN (subscription plan), set by the caller.
# A fresh HOME and empty cwd keep CLAUDE.md, memory, user plugins and MCP servers out of the trial.
# Not --bare: it refuses OAuth, and its effect on automatic skill use is unverified.
set -euo pipefail
arm=$1 task=$2 rep=$3 here=$(cd "$(dirname "$0")" && pwd) trial="$here/results/$arm-$task-$rep"
mkdir -p "$trial/home" "$trial/cwd"
extra=(); mcp=mcp-base.json
case "$arm" in
  none|pointer) ;;                                  # pointer: the prompt gains "Agent docs: <URL>/agent.md"
  skill) extra=(--plugin-dir "$here/../package") ;;
  tuned) extra=(--plugin-dir "$here/../package"); mcp=mcp-tuned.json ;;
  *) echo "unknown arm" >&2; exit 2 ;;
esac
cd "$trial/cwd"
HOME="$trial/home" claude -p "$(cat "$here/prompts/$task-$arm.txt")" \
  "${extra[@]}" --mcp-config "$here/$mcp" --strict-mcp-config \
  --model sonnet --max-turns 40 --max-budget-usd 1.50 --no-session-persistence \
  --allowedTools 'mcp__playwright__*' \
  --output-format stream-json --verbose > "$trial/stream.jsonl"
