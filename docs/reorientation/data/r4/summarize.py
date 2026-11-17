"""Summarize one run's stream-json: turns, tool calls, result sizes, tokens, cost, discovery."""
import json, sys, os, re
out = sys.argv[1]
msgs = [json.loads(l) for l in open(os.path.join(out, 'stream.jsonl')) if l.strip()]
meta = json.load(open(os.path.join(out, 'meta.json')))
calls, results, texts = [], {}, []
for m in msgs:
    if m.get('type') == 'assistant':
        for c in m['message'].get('content', []):
            if c.get('type') == 'tool_use': calls.append(c)
            if c.get('type') == 'text': texts.append(c['text'])
    if m.get('type') == 'user':
        for c in m['message'].get('content', []) if isinstance(m['message'].get('content'), list) else []:
            if c.get('type') == 'tool_result':
                body = c.get('content'); body = body if isinstance(body, str) else json.dumps(body)
                results[c['tool_use_id']] = (len(body), bool(c.get('is_error')))
init = next((m for m in msgs if m.get('subtype') == 'init'), {})
res = next((m for m in msgs if m.get('type') == 'result'), {})
u = res.get('usage', {})
blob = json.dumps([c['input'] for c in calls])
summary = {
    'id': os.path.basename(out), 'model': init.get('model'), 'exit': meta['exit'], 'wallSeconds': meta['wallSeconds'],
    'subtype': res.get('subtype'), 'turns': res.get('num_turns'), 'toolCalls': len(calls),
    'tools': {n: sum(1 for c in calls if c['name'] == n) for n in sorted({c['name'] for c in calls})},
    'toolErrors': sum(1 for v in results.values() if v[1]),
    'resultChars': sum(v[0] for v in results.values()), 'largestResult': max([v[0] for v in results.values()] or [0]),
    'readRecipe': bool(re.search(r'agent\.md', blob)), 'usedAgentApi': 'scribyra.agent' in blob,
    'inputTokens': u.get('input_tokens'), 'cacheCreation': u.get('cache_creation_input_tokens'),
    'cacheRead': u.get('cache_read_input_tokens'), 'outputTokens': u.get('output_tokens'),
    'costUsd': res.get('total_cost_usd'), 'apiMs': res.get('duration_api_ms'),
    'answer': (res.get('result') or '')[-1500:],
}
json.dump(summary, open(os.path.join(out, 'summary.json'), 'w'), indent=1)
with open(os.path.join(out, 'calls.txt'), 'w') as f:
    for c in calls:
        n, r = c['name'].replace('mcp__playwright__', ''), results.get(c['id'], (0, False))
        f.write(f"{n} [{r[0]} chars{' ERROR' if r[1] else ''}] {json.dumps(c['input'])[:400]}\n")
print(json.dumps({k: v for k, v in summary.items() if k != 'answer'}))
print(summary['answer'])
