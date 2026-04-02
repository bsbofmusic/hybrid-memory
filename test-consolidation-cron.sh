#!/usr/bin/env bash
set -euo pipefail
cd /var/lib/openclaw/.openclaw/workspace/npm-pkgs/hybrid-memory
node consolidate_capsules.js 168 160 > /tmp/hybrid-memory-consolidation.json
python3 - <<'PY'
import json
p='/tmp/hybrid-memory-consolidation.json'
obj=json.load(open(p,'r',encoding='utf-8'))
assert obj['ok'] is True
assert 'ops' in obj
print(json.dumps({
  'ok': obj['ok'],
  'planCount': obj['planCount'],
  'writtenCount': obj['writtenCount'],
  'ops': obj['ops'][:5]
}, ensure_ascii=False, indent=2))
PY
