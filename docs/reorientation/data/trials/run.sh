#!/usr/bin/env bash
# Real-model trials of the tab with no plugin: <arm:plain|pointer> <task:fix|edit>. Agent has only a browser tool.
set -uo pipefail
C=<agents>; W=$C/wt/a3-recipe; arm=$1; task=$2; id=$arm-$task-${3:-1}; T=$C/trials/$id; mkdir -p "$T/cwd"
case $task in fix) fx=missing-package; ask='A LaTeX project is open in the Scribyra browser tab. Compile it. Tell me what the problem is and which file and line it is on. Fix the source so it compiles, compile again, and report the outcome, page count and warning count.';;
 edit) fx=thesis; ask='A 100-page LaTeX project is open in the Scribyra browser tab. Open chapters/page-050.tex. Tell me the exact text of line 1 and how many blank lines are in the first 20 lines. Insert a new line 1 containing exactly: % reviewed. Leave everything else unchanged. Compile and report the outcome, page count and warning count.';; esac
[ "$arm" = pointer ] && ask="$ask Agent documentation for this app: http://127.0.0.1:4474/agent.md"
ask="$ask Use only your browser tools, attached to the tab already open. Do not open another browser."
cd "$W"
nix develop -c node scripts/agent-trial-setup.mjs --port=4474 --debug-port=4475 --fixture=$fx --headless > "$T/setup.log" 2>&1 &
S=$!
for i in $(seq 1 300); do grep -q '"attach"' "$T/setup.log" && break; sleep 2; done
grep -q '"attach"' "$T/setup.log" || { echo "$id setup failed"; kill $S; exit 1; }
start=$(date +%s)
cd "$T/cwd"
nix-shell -I nixpkgs=channel:nixpkgs-unstable -p codex nodejs --run "timeout 1200 codex exec --ignore-user-config --skip-git-repo-check --ephemeral -s read-only -m gpt-6.1-sol -c model_reasoning_effort=medium -c approval_policy=\"never\" -c 'mcp_servers.playwright.command=\"npx\"' -c 'mcp_servers.playwright.args=[\"-y\",\"@playwright/mcp@0.0.84\",\"--cdp-endpoint=http://127.0.0.1:4475\"]' -c mcp_servers.playwright.tool_timeout_sec=300 -c mcp_servers.playwright.default_tools_approval_mode=\"approve\" --json -o '$T/answer.md' - > '$T/events.jsonl' 2> '$T/err.log'" <<<"$ask"
echo "elapsed $(( $(date +%s)-start ))" > "$T/meta"
cd "$W"; nix develop -c node --input-type=module -e "
import {chromium} from '@playwright/test';const b=await chromium.connectOverCDP('http://127.0.0.1:4475');const p=b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('4474'));
console.log(JSON.stringify(await p.evaluate(()=>({title:document.title,status:document.querySelector('[role=status][aria-label=\"Compilation status\"]')?.textContent,line1:document.querySelector('[data-line=\"1\"]')?.textContent,line2:document.querySelector('[data-line=\"2\"]')?.textContent}))));await b.close();" > "$T/state.json" 2>>"$T/err.log"
pkill -TERM -P $S 2>/dev/null; kill -TERM $S 2>/dev/null; sleep 3
kids=$(ps -eo pid,args | awk '/vite.js preview .*--port 4474/ && !/awk/ {print $1}'); [ -n "$kids" ] && kill $kids
echo "$id done"
