# Headline table (README top and Cole wake). Usage: python3 harness/headline.py
import json
s = json.load(open('results/summary.json'))
rows = [
	('Per-route JS gzip `/` (bytes)', 'assets-js', 'home JS gzip'),
	('Per-route JS gzip `/account` (bytes)', 'assets-js', 'account JS gzip'),
	('Total client JS gzip, whole build (bytes)', 'build', 'total client JS gzip'),
	('Origin worker entry gzip (bytes)', 'worker-bundle', 'origin entry gzip bytes (entry)'),
	('Origin worker startup CPU (ms)', 'worker-startup', 'origin startup active CPU ms'),
	('Warm TTFB `/` (ms)', 'ttfb', 'home TTFB ms'),
	('Warm TTFB `/account` (ms)', 'ttfb', 'account TTFB ms'),
	('Nested navigation, all steps, CPU 1x, no hover (ms)', 'navigation-cpu1-hover0-all', 'all steps ready ms'),
	('Loading flashes per navigation, CPU 1x, no hover', 'navigation-cpu1-hover0-all', 'flashes per navigation'),
	('Hydration main-thread `/account`, CPU 1x (ms)', 'hydration-cpu1', 'account mainThreadTaskMsUntilHydration'),
	('Lighthouse mobile performance `/`', 'lighthouse-mobile-scores', 'home performance'),
	('Lighthouse mobile LCP `/` (ms)', 'lighthouse-mobile-timings', 'home LCP'),
]
f = lambda x: f'{x:,.0f}' if abs(x) >= 100 else f'{x:,.3g}' if abs(x) < 1 else f'{x:,.1f}'
print('| Metric | A | B | C | A to B (95% CI) | n (A/B/C) |')
print('|---|---|---|---|---|---|')
for label, g, k in rows:
	e = s[g][k]; st = e['stats']; d = e['deltas']['a->b']
	ci = f"{f(d['diff'])} ({f(d['lo'])} to {f(d['hi'])}){' noise' if d['withinNoise'] else ''}"
	print(f"| {label} | {f(st['a']['median'])} | {f(st['b']['median'])} | {f(st['c']['median'])} | {ci} | {st['a']['n']}/{st['b']['n']}/{st['c']['n']} |")
