# Markdown and highlighting migration, October 28, 2026

Switching Marked to TanStack Markdown cut the browser Markdown chunk by 52.3%
raw and 43.0% gzipped. Switching Shiki to TanStack Highlight cut the
highlighting Worker by 97.7% raw and 93.9% gzipped. On this corpus, warm
highlighting was 39.7× faster and the uncached fragment pipeline was 1.9× to
6.7× faster. Origin entry bytes stayed the same. Origin startup CPU did not
improve: its sample median increased from 23.6 to 25.0 ms, with overlapping
sample ranges.

[Raw samples, bundle summaries, versions, and source hashes](./markdown-migration-2026-10-28.json)
are checked in beside this report. The runner is
[`tools/markdown-perf/run.mjs`](../../../tools/markdown-perf/run.mjs).

## Compared source and environment

- Before: commit `832ecf78e29b725527dd9ff072fb2996be18d961`, Marked 18.0.14 and
  Shiki 4.5.0, installed from that commit's lockfile in an isolated temporary
  source snapshot.
- After: the migration worktree based on the same commit, TanStack Markdown
  1.0.0 and TanStack Highlight 1.2.0. The JSON records hashes for the parser,
  renderer, highlighter, styling, and both lockfiles.
- Node v26.12.1, macOS Darwin 25.6.0, Apple M5 Pro, 18 logical CPUs, 64 GiB RAM.
  Both used Vite 8.3.4, esbuild 0.28.2, Wrangler 4.147.0, and Redact 0.1.4.
- The after lockfile also contains the production audit fixes Seroval 1.6.8 →
  1.7.3 and `@hono/node-server` 2.0.11 → 2.1.5. This is the actual before/after
  change, not a dependency-controlled experiment. Small whole-app differences
  cannot be attributed exclusively to the Markdown migration.

The recorded after lockfile fingerprint belongs to the measurement snapshot. A
later CI fix restored Babel development peer dependencies using
`--legacy-peer-deps=false`, matching CI. A global local npm setting had omitted
those peers; the project `.npmrc` now keeps peer resolution consistent with CI.
The raw measurements remain the original captured results; the final shipping
lockfile includes that install fix.

Review follow-ups added an own-property alias check and per-snippet exception
fallback to the highlighter. The recorded source hashes identify the measured
implementation before those small safety guards; the original samples are
retained rather than presented as new measurements of the final review fixes.

## Production bundles

Sizes are KiB, 1 KiB = 1,024 bytes. Gzip uses level 9 separately for each file.
Source maps, build metadata, and non-code public assets are excluded. Both
production builds started with an empty generated `dist/` tree.

| Artifact                          | Before, KiB | After, KiB | Change |
| --------------------------------- | ----------: | ---------: | -----: |
| Browser Markdown chunk, raw       |       59.79 |      28.50 | -52.3% |
| Browser Markdown chunk, gzip      |       18.65 |      10.62 | -43.0% |
| All browser JavaScript, raw       |    3,291.40 |   3,260.47 |  -0.9% |
| All browser JavaScript, gzip      |    1,161.78 |   1,154.51 |  -0.6% |
| All browser CSS, raw              |      386.85 |     386.53 |  -0.1% |
| Origin entry, raw                 |      755.18 |     755.18 |  +0.0% |
| Origin entry, gzip                |      173.88 |     173.88 |  +0.0% |
| All origin JavaScript chunks, raw |   30,382.57 |  30,363.85 |  -0.1% |
| Origin Markdown chunks, raw       |       93.53 |      64.88 | -30.6% |
| Highlight Worker, raw             |    1,321.41 |      30.83 | -97.7% |
| Highlight Worker, gzip            |      189.07 |      11.48 | -93.9% |

The browser Markdown chunk is `assets/markdown-view-*.js`, including Kody's
renderer, styles, and parser. Source maps identify the affected chunks; this is
whole-chunk size, not a claim that every byte belongs to the parser package. The
two origin chunks are `highlight-code-*.js` and `markdown-view-*.js`. The JSON
keeps their exact filenames, hashes, and sizes, plus the largest JavaScript
chunks and a fingerprint of each full artifact manifest.

All-browser and all-origin totals cover every route's emitted JavaScript,
including lazy chunks. They are not the download cost of one page. The
highlighting Worker runs behind the existing service binding, so its large size
reduction saves Worker code, not browser transfer. Neither highlighter appears
in the browser source maps. The slim origin entry remains 773,302 bytes because
Markdown rendering is in deferred chunks.

## Request work on real Markdown

The same four files were read from both snapshots, checked for byte equality,
and fingerprinted in the JSON. They total 86,036 bytes. Their 36 fences contain
8,279 bytes of code: 20 TypeScript, 7 JSON, 4 Bash, 2 Markdown, and 3 plain-text
fences. Both versions extract the same fence counts per document, and both leave
the same 3 snippets plain. Their output has 1,005 versus 910 highlighted spans,
so the token streams are not identical.

Each variant ran in five fresh Node processes, alternating before/after order
between rounds. Each operation had five warmups, then 15 timed batches sized by
a pilot to target about 50 ms per batch, capped at 1,000 operations. Values
below are the median of the five process medians. All batch samples, iteration
counts, and per-process p95 batch averages are retained. These p95 values
describe batched CPU averages, not production request-tail latency.

The identical minified harness uses production dependency branches, Kody's real
parser, tokenizer, and JSX renderer, and the same React-to-Redact aliases as the
production Vite build. It renders through `@tanstack/redact/server` with real
Router and Emotion contexts. A small root route is reused outside the timed
operations, rather than timing full router setup for each fragment.

### Highlighting

| Operation, all 36 snippets      | Before, ms | After, ms | Speedup |
| ------------------------------- | ---------: | --------: | ------: |
| First batch after module import |    416.553 |     4.148 |  100.4× |
| Warm batch                      |      8.381 |     0.211 |   39.7× |

The first batch includes Shiki's lazy grammar/highlighter initialization. It
excludes module loading. The full benchmark harness's module import and initial
router load took a median 21.12 versus 6.85 ms; that is a Node harness
measurement, not a Worker cold-start measurement.

### Uncached fragment pipeline

This calls the actual fence extraction, highlights those fences, then parses and
renders the Markdown fragment with copy buttons and heading IDs enabled. The
renderer parses the Markdown again, as it does in the app. Service-binding
transport, JSON encoding/decoding, caches, sessions, data loaders, and the full
page shell are outside this measurement.

| Document               | Before, ms | After, ms | Speedup |
| ---------------------- | ---------: | --------: | ------: |
| `readme.md`            |      0.724 |     0.379 |   1.91× |
| `package-lifecycle.md` |      3.633 |     0.815 |   4.46× |
| `package-authoring.md` |      6.534 |     0.982 |   6.66× |
| `credentials.md`       |      9.868 |     1.579 |   6.25× |

The stage measurements below help distinguish parsing from rendering. "Extract
fences" includes parsing and traversing the document. "Render" includes parsing,
JSX construction, and SSR with pre-highlighted fences, so it is not a parse-free
renderer measurement.

| Document               | Extract fences, before → after ms | Render, before → after ms |
| ---------------------- | --------------------------------: | ------------------------: |
| `readme.md`            |                     0.256 → 0.110 |             0.420 → 0.274 |
| `package-lifecycle.md` |                     0.885 → 0.234 |             1.278 → 0.552 |
| `package-authoring.md` |                     1.065 → 0.233 |             1.570 → 0.666 |
| `credentials.md`       |                     1.170 → 0.303 |             2.128 → 1.096 |

## Payload size

The fixed 36-snippet JSON response shrank from 87.52 to 56.99 KiB raw, and 6.35
to 5.96 KiB gzipped. That is a 34.9% raw reduction but only a 6.2% gzip
reduction. Repeated styles compress well already.

These are rendered fragments, including their styles and highlighted spans, not
complete HTTP responses:

| Document               | Raw KiB, before → after | Gzip KiB, before → after |
| ---------------------- | ----------------------: | -----------------------: |
| `readme.md`            |           19.22 → 18.92 |              4.60 → 4.55 |
| `package-lifecycle.md` |           55.88 → 48.17 |            11.24 → 10.74 |
| `package-authoring.md` |           69.64 → 60.99 |            12.78 → 12.25 |
| `credentials.md`       |         124.61 → 106.52 |            17.76 → 16.80 |

## Worker startup CPU

Each production entry was profiled five times, sequentially, with
`wrangler check startup`. These are sampled active CPU milliseconds in workerd,
including GC, not elapsed HTTP startup time. The origin uses the exact Vite
production artifact; the highlighting Worker uses its production Wrangler
config.

| Worker    | Before samples, ms           | After samples, ms            |
| --------- | ---------------------------- | ---------------------------- |
| Origin    | 23.6, 20.1, 23.7, 25.1, 23.6 | 24.9, 23.9, 25.2, 25.0, 25.1 |
| Highlight | 13.8, 14.6, 13.8, 13.7, 13.9 | 0.0, 4.9, 4.9, 0.0, 0.0      |

The origin median rose by 1.4 ms, 5.9%. The sample ranges overlap, so this run
does not isolate a small origin startup regression from profiling noise. Keep
watching the existing startup gate. The new highlighting Worker's zero samples
mean its work fell below the profiler's sampling resolution, not that startup is
free. Its nonzero samples are about 5 ms. Do not turn these into a claimed 100%
reduction.

## What these results establish

The browser Markdown path and highlighting Worker are substantially smaller. The
tested uncached Markdown/highlighting/SSR work is substantially faster. The
effect on cache-hit highlighting requests will be smaller because those requests
already skip tokenization. The unchanged origin entry and noisy origin startup
measurements do not support a broad origin cold-start improvement.

This is not a production LCP, INP, TTFB, or concurrent-throughput experiment. It
does not include network latency, Cloudflare edge cache behavior, or browser
hydration. Node request-work timings do not establish exact workerd request CPU.
TanStack Markdown has a different supported syntax profile and TanStack
Highlight has different grammars and tokenization than Marked/Shiki. Equal fence
counts and passing rendering/security tests do not prove arbitrary Markdown or
highlighting-fidelity equivalence.

## Repeat the comparison

Use Node 26 or newer and the repository's npm version. Run from the after
checkout. These commands create a separate source snapshot and install its
locked dependencies; they do not change the current checkout's source or deploy.

```bash
baseline_ref=832ecf78e29b725527dd9ff072fb2996be18d961
baseline_dir=$(mktemp -d /tmp/kody-markdown-before-XXXXXX)
git archive "$baseline_ref" | tar -x -C "$baseline_dir"
(
  cd "$baseline_dir"
  npm ci --include=dev --ignore-scripts --legacy-peer-deps=false
  node node_modules/patch-package/index.js
)
node tools/markdown-perf/run.mjs \
  --before "$baseline_dir" \
  --before-ref "$baseline_ref" \
  --after "$PWD" \
  --out /tmp/kody-markdown-perf \
  --save docs/contributing/performance/markdown-migration-2026-10-28.json
```

The runner cleans each checkout's generated `dist/`, builds through the existing
production Vite helper and `wrangler deploy --dry-run`, and records measurements
serially. Run it without concurrent builds or test suites. `--out` keeps the
full bundle inventory, build logs, timing files, and CPU profiles; `--save`
keeps the compact durable result, including every timing sample and aggregate
bundle sizes. Source maps and built artifacts stay out of Git. Update this
report after reviewing the new raw results rather than silently replacing the
interpretation.
