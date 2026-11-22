| Metric | A | B | C | A to B (95% CI) | n (A/B/C) |
|---|---|---|---|---|---|
| Per-route JS gzip `/` (bytes) | 181,220 | 258,458 | 304,895 | 77,238 (77,238 to 77,238) | 20/20/20 |
| Per-route JS gzip `/account` (bytes) | 366,864 | 272,885 | 319,565 | -93,979 (-93,979 to -93,979) | 20/20/20 |
| Total client JS gzip, whole build (bytes) | 696,991 | 995,710 | 1,043,694 | 298,719 (298,719 to 298,719) | 1/1/1 |
| Origin worker entry gzip (bytes) | 934,061 | 140,235 | 140,235 | -793,826 (-793,826 to -793,826) | 1/1/1 |
| Origin worker startup CPU (ms) | 111 | 44.5 | 43.8 | -66.0 (-96.0 to -60.1) | 10/10/10 |
| Warm TTFB `/` (ms) | 37.9 | 10.3 | 13.6 | -27.5 (-28.7 to -26.7) | 100/100/100 |
| Warm TTFB `/account` (ms) | 69.2 | 39.7 | 39.4 | -29.4 (-31.9 to -26.7) | 100/100/100 |
| Nested navigation, all steps, CPU 1x, no hover (ms) | 133 | 158 | 125 | 25.5 (-0.5 to 47.5) noise | 560/560/560 |
| Loading flashes per navigation, CPU 1x, no hover | 0 | 0 | 0 | 0 (0 to 0) noise | 560/560/560 |
| Hydration main-thread `/account`, CPU 1x (ms) | 160 | 176 | 176 | 16.1 (9.5 to 25.6) | 40/40/40 |
| Lighthouse mobile performance `/` | 75.0 | 98.0 | 100 | 23.0 (16.0 to 27.0) | 5/5/5 |
| Lighthouse mobile LCP `/` (ms) | 5,292 | 1,151 | 1,141 | -4,140 (-4,193 to -4,093) | 5/5/5 |
