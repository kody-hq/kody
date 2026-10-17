import json,sys,statistics
from pathlib import Path
p=Path(sys.argv[1]);c=json.loads((p/'results.json').read_text());groups={}
for r in c['runs']:
 for s in r['steps']:
  if 'firstMarkerMs' not in s:continue
  key=(r['label'],r['latencyMs'],s['name']);g=groups.setdefault(key,[]);g.append(s)
rows=[]
for (label,latency,name),samples in groups.items():
 vals=[s['firstMarkerMs'] for s in samples if isinstance(s.get('firstMarkerMs'),(int,float))]
 traffic=[]
 for s in samples:
  counts={'identity':0,'shell':0,'leaf':0,'other':0}
  for r in s['requests']:
   n=r.get('functionName') or ''
   k='identity' if 'verifySession' in n else 'shell' if 'loadShell' in n else 'leaf' if n or r['path'].endswith('.json') else 'other'
   counts[k]+=1
  traffic.append(counts)
 rows.append(dict(label=label,latencyMs=latency,step=name,n=len(samples),markerMedianMs=statistics.median(vals) if vals else None,markerMinMs=min(vals) if vals else None,markerMaxMs=max(vals) if vals else None,reads=traffic))
report=dict(runs=len(c['runs']),failed=[dict(label=r['label'],latencyMs=r['latencyMs'],round=r['round'],failure=r.get('failure'),pageErrors=r['pageErrors']) for r in c['runs'] if r.get('failure') or r['pageErrors']],rows=rows)
(p/'summary.json').write_text(json.dumps(report,indent=2)+'\n')
for r in rows:print(r['label'],r['latencyMs'],r['step'],r['n'],round(r['markerMedianMs'] or 0,1),r['reads'])
