# Compare page routes: A universal/routes.ts patterns vs B Start file routes. Usage: python3 route-diff.py WT_A WT_B
import os, re, sys, json
a_root, b_root = sys.argv[1], sys.argv[2]
src = open(os.path.join(a_root, 'packages/worker/universal/routes.ts')).read()
a = sorted({p for p in re.findall(r"'(/[^']*)'", src) if not p.endswith('.json')})
def norm_b(f):
    name = re.sub(r'\.(tsx|ts)$', '', f)
    name = name.replace('[.]', '\0').replace('[_]', '_')
    segs = [s.rstrip('_') for s in name.split('.')]
    out = []
    for s in segs:
        s = s.replace('\0', '.')
        if s in ('index', ''): continue
        s = re.sub(r'\{\$(\w+)\}', r':\1', s)
        s = ':' + s[1:] if s.startswith('$') and len(s) > 1 else ('*' if s == '$' else s)
        out.append(s)
    return '/' + '/'.join(out)
bfiles = [f for f in os.listdir(os.path.join(b_root, 'packages/worker/start/routes')) if f != '__root.tsx']
b = sorted({norm_b(f) for f in bfiles})
def a_matches(bp):
    for p in a:
        base = re.sub(r'\(/\*\w+\)$', '', p)
        canon = lambda x: re.sub(r':\w+', ':x', x)
        if canon(base) == canon(bp) or (p != base and canon(bp).startswith(canon(base) + '/')): return True
        if canon(p.replace('(/*relativePath)', '/*').replace('(/*rest)', '/*')) == canon(bp): return True
    return False
def b_covers(ap):
    canon = lambda x: re.sub(r':\w+', ':x', x)
    base = re.sub(r'\(/\*\w+\)$', '', ap)
    return any(canon(bp) == canon(base) or canon(bp).startswith(canon(base) + '/') or canon(bp) == canon(base) + '/*' for bp in b)
print(json.dumps({'aPagePatterns': len(a), 'bFileRoutes': len(b), 'onlyB': [p for p in b if not a_matches(p)], 'onlyA': [p for p in a if not b_covers(p)]}, indent=1))
