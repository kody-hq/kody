#!/usr/bin/env python3
"""Recover literal report snapshots without executing archived commands."""
import ast
import hashlib
import json
import pathlib
import re
import sys

if len(sys.argv) != 3:
    raise SystemExit('Usage: recover-historical.py ROLLOUT_JSONL NEW_DIRECTORY')
source = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=False)
allowed = {
    'COMPARISON.md',
    'QUERY-CACHE-COMPARISON.md',
    'TKDODO-REFACTOR.md',
    'START-QUERY-PATTERN-AUDIT.md',
}
records = []


def save(number, name, body, kind):
    name = name.split('/reports/')[-1]
    if name not in allowed:
        return
    filename = f'{number}-{pathlib.Path(name).name}.txt'
    data = body.encode('utf-8')
    (output / filename).write_bytes(data)
    records.append({
        'line': number,
        'path': name,
        'file': filename,
        'kind': kind,
        'sha256': hashlib.sha256(data).hexdigest(),
        'status': 'Literal report snapshot recovered from a tool-call input, not original raw measurement files or proof that the write succeeded.',
    })


for number, line in enumerate(source.open(), 1):
    try:
        payload = json.loads(line).get('payload', {})
    except json.JSONDecodeError:
        continue
    text = payload.get('input', payload.get('arguments', ''))
    if not isinstance(text, str):
        continue
    commands = []
    for match in re.finditer(r'cmd\s*:\s*("(?:[^"\\]|\\.)*")', text):
        commands.append(json.loads(match[1]))
    if payload.get('name') == 'exec_command':
        try:
            commands.append(json.loads(text)['cmd'])
        except (json.JSONDecodeError, KeyError):
            pass
    for command in commands:
        for match in re.finditer(r'cat\s*>\s*([^\s]*reports/[^\s]+)\s*<<[\'\"]?(\w+)[\'\"]?\n([\s\S]*?)\n\2(?:\n|$)', command):
            save(number, match[1], match[3] + '\n', 'literal shell heredoc')
        for match in re.finditer(r"(?:p|path|report)\.write_text\((\"\"\"[\s\S]*?\"\"\"|'''[\s\S]*?''')", command):
            targets = re.findall(r"['\"]([^'\"]*reports/[^'\"]+\.md)['\"]", command)
            if targets:
                save(number, targets[0], ast.literal_eval(match[1]), 'literal Python write')

thread = re.search(r'([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$', source.name)
(output / 'manifest.json').write_text(json.dumps({
    'threadId': thread[1] if thread else None,
    'source': source.name,
    'artifacts': records,
    'limits': [
        'Draft snapshots from different stages. Do not pool their samples.',
        'Raw Lighthouse traces, full request logs, original inventories and manifests were not recovered from the deleted checkout.',
        'Later shell edits and partially reconstructed patches are not represented as complete final reports.',
    ],
}, indent=2) + '\n')
print(f'Recovered {len(records)} literal report snapshots')
