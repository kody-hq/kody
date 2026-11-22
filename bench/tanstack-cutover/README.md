# Remix 3 vs TanStack Start: kody.codes cutover benchmark (local reconstruction)

This measures the website before and after PR #3561. It reports measurements only and makes no judgement about which framework is better.

| Variant | Revision | What it is |
|---|---|---|
| A | `3679094c5d6bcc75ff7c9b873930d1615886869f` | Remix 3, first parent of the merge |
| B | `2894f12c99431f7e78816b502c24fdc72813dffc` | TanStack Start, Router, Query, Emotion, with Redact replacing React |
| C | B plus a local, uncommitted `vite.config.ts` patch | B with Redact removed (no `redact()` plugin, no Redact aliases, no Redact `noExternal`), so the app runs on real `react` and `react-dom` 19.3.0 |

The C patch (`harness/c-vite-config.patch`) changes only `vite.config.ts`. C builds, renders all 18 routes with status 200, and hydrates. Its source maps contain no `@tanstack/redact` entries and do contain `node_modules/react` and `react-dom` entries.

## Step 0: what Redact is (from the code at B)

- **Package:** `@tanstack/redact` version `0.1.4`. `node_modules/@tanstack/redact/package.json` lines 2 to 6 give the name, the version, the description "React, redacted. A minimal React-API-compatible drop-in replacement." and `"main": "./dist/react/index.js"`. The package ships only `dist/`, `src/` and `package.json`. It has no README. It is pinned in `packages/worker/package.json` line 41, next to `"react": "^19.3.0"` and `"react-dom": "^19.3.0"` (lines 43 and 44). React 19.3.0 is still installed, but no production bundle uses it.
- **What it replaces:** `vite.config.ts` imports `redact` from `@tanstack/redact/vite` (line 5) and adds `redact()` to the plugins (line 202). The plugin's alias table is in `node_modules/@tanstack/redact/dist/vite/index.js` lines 51 to 77. It maps:
  - `react` to `@tanstack/redact`
  - `react/jsx-runtime`, `react/jsx-dev-runtime` and `react/compiler-runtime` to the matching `@tanstack/redact/*` entries
  - `react-dom` to `@tanstack/redact/dom`, and `react-dom/client` to `@tanstack/redact/dom-client`
  - `react-dom/server`, `server.browser`, `server.bun`, `server.edge`, `server.node` and `static.edge` to `@tanstack/redact/server`
  - `react-dom/test-utils` to `@tanstack/redact/dom-test-utils`
  - `scheduler` to `@tanstack/redact/scheduler`
  - every `use-sync-external-store` entry point (`shim`, `with-selector`, and their `.js` forms) to `@tanstack/redact`

  `vite.config.ts` adds its own `redactServerAliases` (lines 53 to 64). These map the exact specifiers `react-dom/server`, `server.edge`, `server.node`, `server.bun`, `server.browser`, `static.edge`, `static.node` and `static` to `@tanstack/redact/server`. Line 233 maps `use-sync-external-store/shim/index.js` to `@tanstack/redact`. Lines 170 and 173 mark `@tanstack/redact` as SSR `noExternal`.
- **Does app code still import `react`?** Yes. 206 non-test source files under `packages/` import from `react` or `react/jsx-runtime`, and 2 import from `react-dom`. JSX compiles through `jsxImportSource` `react` (`packages/worker/tsconfig-client.json` line 10) or `@emotion/react` (`tsconfig-start.json` line 9). The build swaps these imports for Redact at alias time.
- **Reimplementation or wrapper?** It is a reimplementation. `dist/react/index.js` imports only its own modules (`./element.js`, `./hooks.js`, `./context.js`, `./class.js`, `./memo.js`, `./activity.js`, `./children.js` and others). No `.js` file in `dist/` imports `react`. The only match is inside a `.map` file.
- **What the verifier asserts:** `npm run build` at B runs `vite build && node tools/framework-comparison/verify-redact-build.mjs` (root `package.json` line 35). `tools/ci/verify-redact-build.mjs` does not exist. The 60-line verifier checks the client and server source maps:
  - Lines 23 to 31: there must be at least one `/@tanstack/redact/` source, and no `node_modules/(react|react-dom|scheduler)/` source.
  - Lines 35 to 40: none of the retired Remix website runtime files may appear (`src/app/ssr-render.tsx`, `ssr-document.tsx`, `client/client-router.tsx`, `app-root.tsx`, `app.tsx`).
  - Lines 47 to 53: the client must contain no `@resvg/resvg-wasm` and no package-app OAuth server modules.
  - At B it reports "client: 40 Redact source entries" and "server: 25 Redact source entries".

## Headline results

Medians. A to B is the B median minus the A median, with a 95% bootstrap CI. Byte counts with n=1 are deterministic build outputs. Per-route JS bytes were identical in all 20 cold loads. Navigation is pooled over all 14 steps of the six sequences, and flashes are per navigation. Mean flashes per navigation: A 0.14, B 0, C 0.

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

## Environment

| Item | Value |
|---|---|
| Machine | one VM, all variants measured on it, one local server running at a time |
| CPU | `Intel(R) Xeon(R) Processor`, 8 cores |
| RAM | 31 GB, no swap |
| OS | Ubuntu 22.04.5 LTS |
| Node | v26.13.1. A and B both declare `engines.node >=26` and `packageManager npm@11.11.1`. Neither has `.nvmrc` or `.node-version`. |
| npm | 11.20.0 |
| Chrome | Chrome for Testing 156.0.8078.47, headless |
| Playwright | 1.63.0 (harness and both commits) |
| Lighthouse | 13.6.0 |
| web-vitals | 5.1.0 |
| Wrangler | 4.147.0 |

## Method

- **Isolation:** each variant has its own git worktree (`~/bench/wt-a`, `wt-b`, `wt-c`), its own clean `npm ci` from that commit's lockfile, its own production build, and its own local Wrangler/D1 state under the worktree. C is B plus `harness/c-vite-config.patch`, which only changes `vite.config.ts`.
- **Builds:** A and B use `CLOUDFLARE_ENV=test npm run build`. At B this also runs the Redact verifier. C uses `CLOUDFLARE_ENV=test npx vite build`, because B's verifier would fail by design once Redact is removed.
- **Serving:** each commit's own built Wrangler config (`dist/ssr/wrangler.json` at A, `dist/server/wrangler.json` at B and C) runs through `wrangler dev` on the built output with local bindings (`harness/prepare-local-production.mjs`, `serve-local-production.mjs`). No dev server is measured, and no remote bindings, deploys or Cloudflare API calls are used.
- **Fixtures:** the same steps run on every side: `prepare-e2e-env.ts`, `apply-local-app-migrations.ts`, `seed-test-data.ts --local --env test --email me@kentcdodds.com --saved-packages 8`, and then the harness fixtures. Those are one community listing and 12 package jobs (`fixtures/seed-sql.py`), 15 memories, 10 user secrets and an org `bench-org` (`fixtures/memories-secrets-org.ts` via `tools/control-kody.ts execute`), and 10 inbound emails (`fixtures/emails.mjs`, capped by the local free-plan inbound quota). Migrations, `seed-test-data.ts` and `seed-sql.ts` are identical at A and B.
- **Order:** worker checks run in the order A, B, C, C, B, A. Browser and HTTP measurements then run in rounds: round 1 A, B, C; round 2 C, B, A; round 3 A, B, C; round 4 C, B, A. Rounds 3 and 4 skip Lighthouse and asset capture, because asset bytes had CV 0% and Lighthouse already had n=5. They raise n for the timing metrics with high CV. Before each variant round the harness starts the server, waits for login and route resolution (`ready.mjs`), runs a parity check, and warms up with one cold load of every route.
- **Statistics (`harness/stats.mjs`):** n, median, p25, p75, IQR, min, max, mean and CV per metric. Pairwise deltas (A to B, B to C, A to C) are the later median minus the earlier median, with a 95% percentile bootstrap CI (5,000 resamples, each side resampled independently with replacement, fixed seed). "noise" means the CI includes zero.
- **Per metric:**
  1. Assets: Playwright with the cache disabled. A cold direct load of each route records every script and stylesheet response, then gzips and brotli-compresses each body locally. Whole-build totals, the entry chunk, its static import closure and the source-map attribution come from `harness/build-stats.mjs` (generated bytes are attributed to the original source path in each source map).
  2. Worker: each commit's own `tools/check-worker-startup-bundles.ts` (bytes, with gzip added by `worker-gzip.sh`) and its own `check-worker-startup-time.ts` helpers, wrapped by `harness/startup-samples.ts`. The wrapper keeps timeouts as failures instead of aborting the run. Cold first request: `server.sh restart`, wait for `/health`, then a first `GET /` and a first signed-in `GET /account`, alternating which goes first.
  3. Server render: 5 warmup requests and then 25 measured requests per route per round. TTFB is the time to the response headers, and the full time is the time to the last body byte. `Server-Timing` is recorded.
  4. Navigation: 10 repetitions per sequence per round in each of 4 conditions (CPU 1x or 4x, by 0 or 300 ms hover). The timer starts at the click, after any hover. "Ready" means the URL matches the destination and the destination's own heading text (the first h1 to h3 in its server-rendered `<main>` that the source page lacks, so it comes from real fixture data) is inside `main`. For Back steps the destination is the previous URL. For the email filter step there is no destination heading, so "ready" means the URL changed and `main` is not empty, which is a weaker signal. A MutationObserver plus a requestAnimationFrame sampler counts loading frames: a visible `[role=progressbar]`, `[aria-busy=true]`, skeleton or spinner class, `data-loading` or `data-pending`, "Loading" text in main, or an empty main region.
  5. Hydration: CDP tracing plus `Performance.getMetrics`. An init script clicks the header `Menu` button every 10 ms until `aria-expanded` becomes true. The time of the last click before that is the hydration marker. Main-thread task time, script evaluation time and long tasks are summed from the trace up to the marker.
  6. Lighthouse: the `lighthouse` Node API on the same Chrome, with mobile and desktop presets. `/account` uses the session cookie through `extraHeaders`. web-vitals 5.1.0 is injected as an IIFE into every navigation sequence page.

Reproduce: `bash harness/setup.sh <a|b|c> <repo checkout>` once per variant, then `bash harness/run-variant.sh <a|b|c> <round>` per variant per round (and `bash harness/worker.sh` once), then `node harness/stats.mjs`. `bash harness/run-all.sh` runs the whole sequence.

## Results

Generated by `harness/readme-tables.py` from `results/summary.json`. Cells show median (IQR, CV). Delta columns show the later median minus the earlier median, with a 95% bootstrap CI in brackets. "noise" means the CI includes zero. p25, p75, min, max and mean for every cell are in `results/summary.md` and `results/summary.json`.

**1a. Whole client build (bytes, one build per variant)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| total client JS raw | 1/1/1 | 2,376,986 (IQR 0.00, CV 0%) | 2,807,597 (IQR 0.00, CV 0%) | 2,978,340 (IQR 0.00, CV 0%) | 430,611 [430,611, 430,611] | 170,743 [170,743, 170,743] | 601,354 [601,354, 601,354] |
| total client CSS raw | 1/1/1 | 238,431 (IQR 0.00, CV 0%) | 317,013 (IQR 0.00, CV 0%) | 317,013 (IQR 0.00, CV 0%) | 78,582 [78,582, 78,582] | 0.00 [0.00, 0.00] noise | 78,582 [78,582, 78,582] |
| total client JS gzip | 1/1/1 | 696,991 (IQR 0.00, CV 0%) | 995,710 (IQR 0.00, CV 0%) | 1,043,694 (IQR 0.00, CV 0%) | 298,719 [298,719, 298,719] | 47,984 [47,984, 47,984] | 346,703 [346,703, 346,703] |
| total client CSS gzip | 1/1/1 | 51,480 (IQR 0.00, CV 0%) | 66,800 (IQR 0.00, CV 0%) | 66,800 (IQR 0.00, CV 0%) | 15,320 [15,320, 15,320] | 0.00 [0.00, 0.00] noise | 15,320 [15,320, 15,320] |
| total client JS brotli | 1/1/1 | 594,408 (IQR 0.00, CV 0%) | 870,421 (IQR 0.00, CV 0%) | 911,358 (IQR 0.00, CV 0%) | 276,013 [276,013, 276,013] | 40,937 [40,937, 40,937] | 316,950 [316,950, 316,950] |
| total client CSS brotli | 1/1/1 | 44,045 (IQR 0.00, CV 0%) | 57,543 (IQR 0.00, CV 0%) | 57,543 (IQR 0.00, CV 0%) | 13,498 [13,498, 13,498] | 0.00 [0.00, 0.00] noise | 13,498 [13,498, 13,498] |
| client JS files | 1/1/1 | 57.0 (IQR 0.00, CV 0%) | 612 (IQR 0.00, CV 0%) | 611 (IQR 0.00, CV 0%) | 555 [555, 555] | -1.00 [-1.00, -1.00] | 554 [554, 554] |
| entry + static closure JS raw | 1/1/1 | 576,005 (IQR 0.00, CV 0%) | 739,833 (IQR 0.00, CV 0%) | 900,686 (IQR 0.00, CV 0%) | 163,828 [163,828, 163,828] | 160,853 [160,853, 160,853] | 324,681 [324,681, 324,681] |
| entry + static closure JS gzip | 1/1/1 | 180,734 (IQR 0.00, CV 0%) | 223,971 (IQR 0.00, CV 0%) | 270,383 (IQR 0.00, CV 0%) | 43,237 [43,237, 43,237] | 46,412 [46,412, 46,412] | 89,649 [89,649, 89,649] |
| entry + static closure JS brotli | 1/1/1 | 156,209 (IQR 0.00, CV 0%) | 193,421 (IQR 0.00, CV 0%) | 232,693 (IQR 0.00, CV 0%) | 37,212 [37,212, 37,212] | 39,272 [39,272, 39,272] | 76,484 [76,484, 76,484] |
| entry closure files | 1/1/1 | 22.0 (IQR 0.00, CV 0%) | 57.0 (IQR 0.00, CV 0%) | 56.0 (IQR 0.00, CV 0%) | 35.0 [35.0, 35.0] | -1.00 [-1.00, -1.00] | 34.0 [34.0, 34.0] |
| entry chunk JS gzip | 1/1/1 | 63,495 (IQR 0.00, CV 0%) | 84,141 (IQR 0.00, CV 0%) | 129,288 (IQR 0.00, CV 0%) | 20,646 [20,646, 20,646] | 45,147 [45,147, 45,147] | 65,793 [65,793, 65,793] |

**1b. Source-map attribution, whole client build (generated bytes)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| unmapped | 1/1/1 | 44,459 (IQR 0.00, CV 0%) | 229,257 (IQR 0.00, CV 0%) | 229,509 (IQR 0.00, CV 0%) | 184,798 [184,798, 184,798] | 252 [252, 252] | 185,050 [185,050, 185,050] |
| app | 1/1/1 | 1,883,093 (IQR 0.00, CV 0%) | 1,954,645 (IQR 0.00, CV 0%) | 1,965,867 (IQR 0.00, CV 0%) | 71,552 [71,552, 71,552] | 11,222 [11,222, 11,222] | 82,774 [82,774, 82,774] |
| remix | 1/0/0 | 152,971 (IQR 0.00, CV 0%) | n/a | n/a | n/a | n/a | n/a |
| other-deps | 1/1/1 | 295,740 (IQR 0.00, CV 0%) | 408,906 (IQR 0.00, CV 0%) | 410,557 (IQR 0.00, CV 0%) | 113,166 [113,166, 113,166] | 1,651 [1,651, 1,651] | 114,817 [114,817, 114,817] |
| tanstack-router | 0/1/1 | n/a | 83,473 (IQR 0.00, CV 0%) | 84,277 (IQR 0.00, CV 0%) | n/a | 804 [804, 804] | n/a |
| tanstack-query | 0/1/1 | n/a | 41,383 (IQR 0.00, CV 0%) | 41,761 (IQR 0.00, CV 0%) | n/a | 378 [378, 378] | n/a |
| tanstack-start | 0/1/1 | n/a | 10,410 (IQR 0.00, CV 0%) | 10,419 (IQR 0.00, CV 0%) | n/a | 9.00 [9.00, 9.00] | n/a |
| redact | 0/1/0 | n/a | 62,726 (IQR 0.00, CV 0%) | n/a | n/a | n/a | n/a |
| emotion | 0/1/1 | n/a | 15,494 (IQR 0.00, CV 0%) | 15,627 (IQR 0.00, CV 0%) | n/a | 133 [133, 133] | n/a |
| react | 0/0/1 | n/a | n/a | 219,013 (IQR 0.00, CV 0%) | n/a | n/a | n/a |

**1c. Source-map attribution, entry chunk plus static import closure (generated bytes)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| unmapped | 1/1/1 | 10,388 (IQR 0.00, CV 0%) | 38,782 (IQR 0.00, CV 0%) | 38,160 (IQR 0.00, CV 0%) | 28,394 [28,394, 28,394] | -622 [-622, -622] | 27,772 [27,772, 27,772] |
| remix | 1/0/0 | 126,265 (IQR 0.00, CV 0%) | n/a | n/a | n/a | n/a | n/a |
| app | 1/1/1 | 439,259 (IQR 0.00, CV 0%) | 379,419 (IQR 0.00, CV 0%) | 381,781 (IQR 0.00, CV 0%) | -59,840 [-59,840, -59,840] | 2,362 [2,362, 2,362] | -57,478 [-57,478, -57,478] |
| redact | 0/1/0 | n/a | 62,726 (IQR 0.00, CV 0%) | n/a | n/a | n/a | n/a |
| tanstack-router | 0/1/1 | n/a | 83,473 (IQR 0.00, CV 0%) | 84,277 (IQR 0.00, CV 0%) | n/a | 804 [804, 804] | n/a |
| tanstack-start | 0/1/1 | n/a | 10,169 (IQR 0.00, CV 0%) | 10,166 (IQR 0.00, CV 0%) | n/a | -3.00 [-3.00, -3.00] | n/a |
| other-deps | 0/1/1 | n/a | 113,275 (IQR 0.00, CV 0%) | 114,911 (IQR 0.00, CV 0%) | n/a | 1,636 [1,636, 1,636] | n/a |
| tanstack-query | 0/1/1 | n/a | 36,345 (IQR 0.00, CV 0%) | 36,594 (IQR 0.00, CV 0%) | n/a | 249 [249, 249] | n/a |
| emotion | 0/1/1 | n/a | 15,494 (IQR 0.00, CV 0%) | 15,627 (IQR 0.00, CV 0%) | n/a | 133 [133, 133] | n/a |
| react | 0/0/1 | n/a | n/a | 219,013 (IQR 0.00, CV 0%) | n/a | n/a | n/a |

**1d. JS requested on a cold direct load, per route (gzip bytes, request count; raw and brotli in results/summary.md)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| home JS gzip | 20/20/20 | 181,220 (IQR 0.00, CV 0%) | 258,458 (IQR 0.00, CV 0%) | 304,895 (IQR 0.00, CV 0%) | 77,238 [77,238, 77,238] | 46,437 [46,437, 46,437] | 123,675 [123,675, 123,675] |
| home JS requests | 20/20/20 | 23.0 (IQR 0.00, CV 0%) | 70.0 (IQR 0.00, CV 0%) | 69.0 (IQR 0.00, CV 0%) | 47.0 [47.0, 47.0] | -1.00 [-1.00, -1.00] | 46.0 [46.0, 46.0] |
| pricing JS gzip | 20/20/20 | 280,954 (IQR 0.00, CV 0%) | 229,297 (IQR 0.00, CV 0%) | 275,704 (IQR 0.00, CV 0%) | -51,657 [-51,657, -51,657] | 46,407 [46,407, 46,407] | -5,250 [-5,250, -5,250] |
| pricing JS requests | 20/20/20 | 28.0 (IQR 0.00, CV 0%) | 62.0 (IQR 0.00, CV 0%) | 61.0 (IQR 0.00, CV 0%) | 34.0 [34.0, 34.0] | -1.00 [-1.00, -1.00] | 33.0 [33.0, 33.0] |
| docs JS gzip | 20/20/20 | 409,393 (IQR 0.00, CV 0%) | 273,207 (IQR 0.00, CV 0%) | 319,662 (IQR 0.00, CV 0%) | -136,186 [-136,186, -136,186] | 46,455 [46,455, 46,455] | -89,731 [-89,731, -89,731] |
| docs JS requests | 20/20/20 | 47.0 (IQR 0.00, CV 0%) | 82.0 (IQR 0.00, CV 0%) | 81.0 (IQR 0.00, CV 0%) | 35.0 [35.0, 35.0] | -1.00 [-1.00, -1.00] | 34.0 [34.0, 34.0] |
| docs-deep JS gzip | 20/20/20 | 409,393 (IQR 0.00, CV 0%) | 273,348 (IQR 0.00, CV 0%) | 319,802 (IQR 0.00, CV 0%) | -136,045 [-136,045, -136,045] | 46,454 [46,454, 46,454] | -89,591 [-89,591, -89,591] |
| docs-deep JS requests | 20/20/20 | 47.0 (IQR 0.00, CV 0%) | 83.0 (IQR 0.00, CV 0%) | 82.0 (IQR 0.00, CV 0%) | 36.0 [36.0, 36.0] | -1.00 [-1.00, -1.00] | 35.0 [35.0, 35.0] |
| blog JS gzip | 20/20/20 | 409,393 (IQR 0.00, CV 0%) | 227,723 (IQR 0.00, CV 0%) | 274,130 (IQR 0.00, CV 0%) | -181,670 [-181,670, -181,670] | 46,407 [46,407, 46,407] | -135,263 [-135,263, -135,263] |
| blog JS requests | 20/20/20 | 47.0 (IQR 0.00, CV 0%) | 64.0 (IQR 0.00, CV 0%) | 63.0 (IQR 0.00, CV 0%) | 17.0 [17.0, 17.0] | -1.00 [-1.00, -1.00] | 16.0 [16.0, 16.0] |
| blog-post JS gzip | 20/20/20 | 409,393 (IQR 0.00, CV 0%) | 249,872 (IQR 0.00, CV 0%) | 296,312 (IQR 0.00, CV 0%) | -159,521 [-159,521, -159,521] | 46,440 [46,440, 46,440] | -113,081 [-113,081, -113,081] |
| blog-post JS requests | 20/20/20 | 47.0 (IQR 0.00, CV 0%) | 69.0 (IQR 0.00, CV 0%) | 68.0 (IQR 0.00, CV 0%) | 22.0 [22.0, 22.0] | -1.00 [-1.00, -1.00] | 21.0 [21.0, 21.0] |
| community JS gzip | 20/20/20 | 260,473 (IQR 0.00, CV 0%) | 237,890 (IQR 0.00, CV 0%) | 284,312 (IQR 0.00, CV 0%) | -22,583 [-22,583, -22,583] | 46,422 [46,422, 46,422] | 23,839 [23,839, 23,839] |
| community JS requests | 20/20/20 | 34.0 (IQR 0.00, CV 0%) | 71.0 (IQR 0.00, CV 0%) | 70.0 (IQR 0.00, CV 0%) | 37.0 [37.0, 37.0] | -1.00 [-1.00, -1.00] | 36.0 [36.0, 36.0] |
| profile JS gzip | 20/20/20 | 181,220 (IQR 0.00, CV 0%) | 236,488 (IQR 0.00, CV 0%) | 282,958 (IQR 0.00, CV 0%) | 55,268 [55,268, 55,268] | 46,470 [46,470, 46,470] | 101,738 [101,738, 101,738] |
| profile JS requests | 20/20/20 | 23.0 (IQR 0.00, CV 0%) | 71.0 (IQR 0.00, CV 0%) | 70.0 (IQR 0.00, CV 0%) | 48.0 [48.0, 48.0] | -1.00 [-1.00, -1.00] | 47.0 [47.0, 47.0] |
| community-package JS gzip | 20/20/20 | 260,473 (IQR 0.00, CV 0%) | 268,892 (IQR 0.00, CV 0%) | 315,418 (IQR 0.00, CV 0%) | 8,419 [8,419, 8,419] | 46,526 [46,526, 46,526] | 54,945 [54,945, 54,945] |
| community-package JS requests | 20/20/20 | 34.0 (IQR 0.00, CV 0%) | 85.0 (IQR 0.00, CV 0%) | 84.0 (IQR 0.00, CV 0%) | 51.0 [51.0, 51.0] | -1.00 [-1.00, -1.00] | 50.0 [50.0, 50.0] |
| account JS gzip | 20/20/20 | 366,864 (IQR 0.00, CV 0%) | 272,885 (IQR 0.00, CV 0%) | 319,565 (IQR 0.00, CV 0%) | -93,979 [-93,979, -93,979] | 46,680 [46,680, 46,680] | -47,299 [-47,299, -47,299] |
| account JS requests | 20/20/20 | 40.0 (IQR 0.00, CV 0%) | 93.0 (IQR 0.00, CV 0%) | 92.0 (IQR 0.00, CV 0%) | 53.0 [53.0, 53.0] | -1.00 [-1.00, -1.00] | 52.0 [52.0, 52.0] |
| jobs JS gzip | 20/20/20 | 366,864 (IQR 0.00, CV 0%) | 250,935 (IQR 0.00, CV 0%) | 297,490 (IQR 0.00, CV 0%) | -115,929 [-115,929, -115,929] | 46,555 [46,555, 46,555] | -69,374 [-69,374, -69,374] |
| jobs JS requests | 20/20/20 | 40.0 (IQR 0.00, CV 0%) | 79.0 (IQR 0.00, CV 0%) | 78.0 (IQR 0.00, CV 0%) | 39.0 [39.0, 39.0] | -1.00 [-1.00, -1.00] | 38.0 [38.0, 38.0] |
| job-detail JS gzip | 20/20/20 | 366,864 (IQR 0.00, CV 0%) | 250,963 (IQR 0.00, CV 0%) | 297,517 (IQR 0.00, CV 0%) | -115,901 [-115,901, -115,901] | 46,554 [46,554, 46,554] | -69,347 [-69,347, -69,347] |
| job-detail JS requests | 20/20/20 | 40.0 (IQR 0.00, CV 0%) | 79.0 (IQR 0.00, CV 0%) | 78.0 (IQR 0.00, CV 0%) | 39.0 [39.0, 39.0] | -1.00 [-1.00, -1.00] | 38.0 [38.0, 38.0] |
| email JS gzip | 20/20/20 | 366,864 (IQR 0.00, CV 0%) | 258,284 (IQR 0.00, CV 0%) | 304,883 (IQR 0.00, CV 0%) | -108,580 [-108,580, -108,580] | 46,599 [46,599, 46,599] | -61,981 [-61,981, -61,981] |
| email JS requests | 20/20/20 | 40.0 (IQR 0.00, CV 0%) | 78.0 (IQR 0.00, CV 0%) | 77.0 (IQR 0.00, CV 0%) | 38.0 [38.0, 38.0] | -1.00 [-1.00, -1.00] | 37.0 [37.0, 37.0] |
| email-message JS gzip | 20/20/20 | 366,864 (IQR 0.00, CV 0%) | 258,300 (IQR 0.00, CV 0%) | 304,890 (IQR 0.00, CV 0%) | -108,564 [-108,564, -108,564] | 46,590 [46,590, 46,590] | -61,974 [-61,974, -61,974] |
| email-message JS requests | 20/20/20 | 40.0 (IQR 0.00, CV 0%) | 78.0 (IQR 0.00, CV 0%) | 77.0 (IQR 0.00, CV 0%) | 38.0 [38.0, 38.0] | -1.00 [-1.00, -1.00] | 37.0 [37.0, 37.0] |
| credentials JS gzip | 20/20/20 | 366,864 (IQR 0.00, CV 0%) | 250,529 (IQR 0.00, CV 0%) | 297,053 (IQR 0.00, CV 0%) | -116,335 [-116,335, -116,335] | 46,524 [46,524, 46,524] | -69,811 [-69,811, -69,811] |
| credentials JS requests | 20/20/20 | 40.0 (IQR 0.00, CV 0%) | 73.0 (IQR 0.00, CV 0%) | 72.0 (IQR 0.00, CV 0%) | 33.0 [33.0, 33.0] | -1.00 [-1.00, -1.00] | 32.0 [32.0, 32.0] |
| credential-detail JS gzip | 20/20/20 | 366,864 (IQR 0.00, CV 0%) | 250,555 (IQR 0.00, CV 0%) | 297,077 (IQR 0.00, CV 0%) | -116,309 [-116,309, -116,309] | 46,522 [46,522, 46,522] | -69,787 [-69,787, -69,787] |
| credential-detail JS requests | 20/20/20 | 40.0 (IQR 0.00, CV 0%) | 73.0 (IQR 0.00, CV 0%) | 72.0 (IQR 0.00, CV 0%) | 33.0 [33.0, 33.0] | -1.00 [-1.00, -1.00] | 32.0 [32.0, 32.0] |
| memories JS gzip | 20/20/20 | 366,864 (IQR 0.00, CV 0%) | 249,142 (IQR 0.00, CV 0%) | 295,684 (IQR 0.00, CV 0%) | -117,722 [-117,722, -117,722] | 46,542 [46,542, 46,542] | -71,180 [-71,180, -71,180] |
| memories JS requests | 20/20/20 | 40.0 (IQR 0.00, CV 0%) | 77.0 (IQR 0.00, CV 0%) | 76.0 (IQR 0.00, CV 0%) | 37.0 [37.0, 37.0] | -1.00 [-1.00, -1.00] | 36.0 [36.0, 36.0] |
| org-workspace JS gzip | 20/20/20 | 366,864 (IQR 0.00, CV 0%) | 254,832 (IQR 0.00, CV 0%) | 301,376 (IQR 0.00, CV 0%) | -112,032 [-112,032, -112,032] | 46,544 [46,544, 46,544] | -65,488 [-65,488, -65,488] |
| org-workspace JS requests | 20/20/20 | 40.0 (IQR 0.00, CV 0%) | 74.0 (IQR 0.00, CV 0%) | 73.0 (IQR 0.00, CV 0%) | 34.0 [34.0, 34.0] | -1.00 [-1.00, -1.00] | 33.0 [33.0, 33.0] |

**1e. CSS requested on a cold direct load, per route**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| home CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| home CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| pricing CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| pricing CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| docs CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| docs CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| docs-deep CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| docs-deep CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| blog CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| blog CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| blog-post CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| blog-post CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| community CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| community CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| profile CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| profile CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| community-package CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| community-package CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| account CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| account CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| jobs CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| jobs CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| job-detail CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| job-detail CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| email CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| email CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| email-message CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| email-message CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| credentials CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| credentials CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| credential-detail CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| credential-detail CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| memories CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| memories CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |
| org-workspace CSS gzip | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 (IQR 0.00, CV 0%) | 15,304 [15,304, 15,304] | 0.00 [0.00, 0.00] noise | 15,304 [15,304, 15,304] |
| org-workspace CSS requests | 20/20/20 | 0.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 0%) | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] noise | 1.00 [1.00, 1.00] |

**2a. Worker bundles (bytes)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| origin entry raw bytes (commit script) | 1/1/1 | 3,931,760 (IQR 0.00, CV 0%) | 595,779 (IQR 0.00, CV 0%) | 595,779 (IQR 0.00, CV 0%) | -3,335,981 [-3,335,981, -3,335,981] | 0.00 [0.00, 0.00] noise | -3,335,981 [-3,335,981, -3,335,981] |
| platform entry raw bytes (commit script) | 1/1/1 | 5,810,685 (IQR 0.00, CV 0%) | 5,763,084 (IQR 0.00, CV 0%) | 5,763,084 (IQR 0.00, CV 0%) | -47,601 [-47,601, -47,601] | 0.00 [0.00, 0.00] noise | -47,601 [-47,601, -47,601] |
| runtime entry raw bytes (commit script) | 1/1/1 | 4,371,371 (IQR 0.00, CV 0%) | 4,310,540 (IQR 0.00, CV 0%) | 4,310,540 (IQR 0.00, CV 0%) | -60,831 [-60,831, -60,831] | 0.00 [0.00, 0.00] noise | -60,831 [-60,831, -60,831] |
| origin entry gzip bytes (entry) | 1/1/1 | 934,061 (IQR 0.00, CV 0%) | 140,235 (IQR 0.00, CV 0%) | 140,235 (IQR 0.00, CV 0%) | -793,826 [-793,826, -793,826] | 0.00 [0.00, 0.00] noise | -793,826 [-793,826, -793,826] |
| platform entry gzip bytes (entry) | 1/1/1 | 1,622,728 (IQR 0.00, CV 0%) | 1,606,519 (IQR 0.00, CV 0%) | 1,606,519 (IQR 0.00, CV 0%) | -16,209 [-16,209, -16,209] | 0.00 [0.00, 0.00] noise | -16,209 [-16,209, -16,209] |
| runtime entry gzip bytes (entry) | 1/1/1 | 1,243,315 (IQR 0.00, CV 0%) | 1,223,471 (IQR 0.00, CV 0%) | 1,223,471 (IQR 0.00, CV 0%) | -19,844 [-19,844, -19,844] | 0.00 [0.00, 0.00] noise | -19,844 [-19,844, -19,844] |
| origin server JS total raw bytes (all chunks, excl wasm) | 1/1/1 | 26,034,858 (IQR 0.00, CV 0%) | 27,810,169 (IQR 0.00, CV 0%) | 28,277,589 (IQR 0.00, CV 0%) | 1,775,311 [1,775,311, 1,775,311] | 467,420 [467,420, 467,420] | 2,242,731 [2,242,731, 2,242,731] |
| origin server JS total gzip bytes (all chunks, excl wasm) | 1/1/1 | 6,331,389 (IQR 0.00, CV 0%) | 7,166,633 (IQR 0.00, CV 0%) | 7,251,540 (IQR 0.00, CV 0%) | 835,244 [835,244, 835,244] | 84,907 [84,907, 84,907] | 920,151 [920,151, 920,151] |
| origin server JS files | 1/1/1 | 256 (IQR 0.00, CV 0%) | 1,268 (IQR 0.00, CV 0%) | 1,268 (IQR 0.00, CV 0%) | 1,012 [1,012, 1,012] | 0.00 [0.00, 0.00] noise | 1,012 [1,012, 1,012] |

**2b. Worker startup CPU (wrangler check startup, ms)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| origin startup active CPU ms | 10/10/10 | 111 (IQR 27.1, CV 20%) | 44.5 (IQR 3.68, CV 19%) | 43.8 (IQR 2.40, CV 13%) | -66.0 [-96.0, -60.1] | -0.75 [-3.95, 3.10] noise | -66.8 [-97.1, -61.0] |
| platform startup active CPU ms | 10/10/10 | 138 (IQR 10.6, CV 5%) | 133 (IQR 8.37, CV 15%) | 133 (IQR 2.38, CV 3%) | -5.25 [-15.9, 18.9] noise | -0.65 [-24.4, 2.55] noise | -5.90 [-16.6, -2.80] |
| runtime startup active CPU ms | 10/10/10 | 78.4 (IQR 6.05, CV 5%) | 76.8 (IQR 7.42, CV 7%) | 72.7 (IQR 5.85, CV 22%) | -1.65 [-7.60, 4.60] noise | -4.05 [-9.90, 6.35] noise | -5.70 [-10.5, 7.21] noise |

**2c. First request after a local server restart (ms)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| first / TTFB ms | 20/20/20 | 97.0 (IQR 46.6, CV 37%) | 51.7 (IQR 26.8, CV 31%) | 62.6 (IQR 31.9, CV 29%) | -45.2 [-66.9, -8.01] | 10.9 [-16.0, 31.9] noise | -34.4 [-63.4, 2.66] noise |
| first / full ms | 20/20/20 | 97.6 (IQR 46.8, CV 37%) | 52.4 (IQR 26.9, CV 31%) | 64.6 (IQR 30.8, CV 29%) | -45.2 [-66.1, -7.79] | 12.2 [-14.3, 32.8] noise | -33.1 [-62.0, 3.69] noise |
| first /account TTFB ms | 20/20/20 | 133 (IQR 46.2, CV 18%) | 101 (IQR 21.4, CV 16%) | 103 (IQR 27.2, CV 19%) | -31.4 [-60.6, -14.6] | 1.21 [-10.5, 17.6] noise | -30.1 [-58.2, -11.7] |
| first /account full ms | 20/20/20 | 133 (IQR 46.2, CV 18%) | 102 (IQR 21.5, CV 16%) | 103 (IQR 27.9, CV 19%) | -31.5 [-60.9, -13.8] | 1.36 [-10.4, 18.0] noise | -30.1 [-58.3, -10.9] |

**3a. Warm TTFB per route (ms)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| home TTFB ms | 100/100/100 | 37.9 (IQR 4.55, CV 12%) | 10.3 (IQR 2.20, CV 22%) | 13.6 (IQR 3.79, CV 32%) | -27.5 [-28.7, -26.7] | 3.27 [2.72, 4.31] | -24.2 [-25.4, -23.1] |
| pricing TTFB ms | 100/100/100 | 33.5 (IQR 3.62, CV 18%) | 7.02 (IQR 1.82, CV 28%) | 7.67 (IQR 1.29, CV 22%) | -26.4 [-27.0, -25.8] | 0.65 [0.31, 0.97] | -25.8 [-26.3, -25.1] |
| docs TTFB ms | 100/100/100 | 37.0 (IQR 4.46, CV 27%) | 10.9 (IQR 2.51, CV 21%) | 12.4 (IQR 3.42, CV 22%) | -26.0 [-26.8, -25.2] | 1.45 [0.87, 2.13] | -24.6 [-25.3, -23.6] |
| docs-deep TTFB ms | 100/100/100 | 49.4 (IQR 5.72, CV 21%) | 19.1 (IQR 5.56, CV 24%) | 26.0 (IQR 4.38, CV 18%) | -30.4 [-31.3, -28.8] | 6.90 [5.28, 8.46] | -23.5 [-24.7, -21.9] |
| blog TTFB ms | 100/100/100 | 34.0 (IQR 4.79, CV 23%) | 7.56 (IQR 1.84, CV 37%) | 8.12 (IQR 1.06, CV 33%) | -26.4 [-27.5, -25.5] | 0.56 [0.29, 0.97] | -25.9 [-26.8, -24.9] |
| blog-post TTFB ms | 100/100/100 | 33.6 (IQR 4.91, CV 15%) | 7.54 (IQR 0.86, CV 35%) | 8.57 (IQR 2.11, CV 78%) | -26.1 [-26.9, -25.1] | 1.03 [0.63, 1.32] | -25.0 [-25.9, -24.0] |
| community TTFB ms | 100/100/100 | 41.8 (IQR 4.36, CV 29%) | 14.6 (IQR 3.58, CV 29%) | 15.6 (IQR 4.52, CV 26%) | -27.2 [-28.0, -26.1] | 0.99 [-0.027, 1.96] noise | -26.3 [-27.2, -25.0] |
| profile TTFB ms | 100/100/100 | 53.4 (IQR 10.1, CV 16%) | 24.5 (IQR 6.00, CV 32%) | 24.7 (IQR 6.66, CV 26%) | -28.9 [-31.1, -26.8] | 0.22 [-1.47, 1.82] noise | -28.7 [-30.9, -26.7] |
| community-package TTFB ms | 100/100/100 | 49.3 (IQR 12.0, CV 31%) | 20.1 (IQR 4.90, CV 18%) | 22.2 (IQR 11.1, CV 41%) | -29.2 [-31.1, -27.2] | 2.13 [0.33, 4.07] | -27.0 [-29.3, -24.6] |
| account TTFB ms | 100/100/100 | 69.2 (IQR 10.4, CV 18%) | 39.7 (IQR 9.94, CV 28%) | 39.4 (IQR 10.5, CV 21%) | -29.4 [-31.9, -26.7] | -0.32 [-2.88, 3.05] noise | -29.8 [-32.3, -25.7] |
| jobs TTFB ms | 100/100/100 | 72.7 (IQR 14.8, CV 28%) | 39.5 (IQR 9.97, CV 20%) | 41.8 (IQR 10.4, CV 24%) | -33.2 [-35.6, -30.7] | 2.25 [-0.47, 4.92] noise | -30.9 [-33.9, -28.0] |
| job-detail TTFB ms | 100/100/100 | 73.0 (IQR 14.2, CV 22%) | 41.7 (IQR 9.19, CV 20%) | 47.3 (IQR 9.84, CV 28%) | -31.4 [-33.4, -28.0] | 5.61 [2.19, 8.11] | -25.8 [-28.3, -23.0] |
| email TTFB ms | 100/100/100 | 81.0 (IQR 15.1, CV 21%) | 51.9 (IQR 12.5, CV 28%) | 56.1 (IQR 14.3, CV 19%) | -29.1 [-32.2, -26.2] | 4.19 [1.13, 6.82] | -24.9 [-28.5, -21.8] |
| email-message TTFB ms | 100/100/100 | 86.2 (IQR 16.7, CV 13%) | 59.1 (IQR 14.2, CV 19%) | 59.4 (IQR 15.5, CV 22%) | -27.1 [-32.1, -23.1] | 0.34 [-2.71, 5.39] noise | -26.8 [-31.8, -21.3] |
| credentials TTFB ms | 100/100/100 | 63.2 (IQR 10.4, CV 13%) | 32.7 (IQR 7.25, CV 21%) | 36.3 (IQR 7.86, CV 23%) | -30.5 [-32.6, -28.1] | 3.60 [2.25, 5.21] | -26.9 [-29.0, -24.5] |
| credential-detail TTFB ms | 100/100/100 | 91.6 (IQR 14.4, CV 20%) | 63.0 (IQR 14.6, CV 27%) | 66.6 (IQR 18.2, CV 23%) | -28.7 [-31.4, -25.0] | 3.61 [-1.62, 8.22] noise | -25.1 [-30.2, -19.4] |
| memories TTFB ms | 100/100/100 | 58.8 (IQR 7.62, CV 37%) | 29.6 (IQR 7.48, CV 22%) | 31.5 (IQR 8.46, CV 26%) | -29.2 [-30.7, -27.1] | 1.89 [-0.27, 3.40] noise | -27.3 [-29.5, -25.3] |
| org-workspace TTFB ms | 100/100/100 | 59.1 (IQR 8.64, CV 15%) | 36.5 (IQR 11.0, CV 28%) | 33.6 (IQR 9.27, CV 45%) | -22.6 [-24.2, -20.4] | -2.90 [-5.06, -1.10] | -25.5 [-26.8, -24.0] |

**3b. Warm full HTML response time per route (ms)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| home full HTML ms | 100/100/100 | 38.3 (IQR 4.58, CV 12%) | 10.5 (IQR 2.39, CV 23%) | 14.8 (IQR 3.98, CV 30%) | -27.8 [-28.8, -26.8] | 4.30 [3.57, 5.18] | -23.5 [-24.6, -22.3] |
| pricing full HTML ms | 100/100/100 | 33.6 (IQR 3.68, CV 18%) | 7.18 (IQR 2.12, CV 36%) | 8.18 (IQR 1.26, CV 22%) | -26.4 [-27.0, -25.9] | 1.00 [0.68, 1.44] | -25.4 [-26.0, -24.8] |
| docs full HTML ms | 100/100/100 | 37.2 (IQR 4.53, CV 27%) | 11.1 (IQR 2.49, CV 21%) | 13.2 (IQR 3.46, CV 25%) | -26.1 [-26.9, -25.3] | 2.09 [1.53, 3.00] | -24.0 [-24.8, -22.9] |
| docs-deep full HTML ms | 100/100/100 | 50.1 (IQR 5.84, CV 21%) | 19.7 (IQR 5.90, CV 23%) | 29.6 (IQR 6.04, CV 23%) | -30.5 [-31.4, -28.8] | 9.90 [7.83, 11.6] | -20.6 [-22.2, -18.7] |
| blog full HTML ms | 100/100/100 | 34.1 (IQR 4.78, CV 24%) | 7.65 (IQR 1.84, CV 36%) | 8.51 (IQR 1.16, CV 33%) | -26.5 [-27.7, -25.7] | 0.87 [0.55, 1.28] | -25.6 [-26.8, -24.8] |
| blog-post full HTML ms | 100/100/100 | 33.8 (IQR 4.97, CV 15%) | 7.63 (IQR 0.86, CV 35%) | 9.10 (IQR 2.40, CV 74%) | -26.2 [-27.1, -25.2] | 1.47 [1.04, 1.83] | -24.7 [-25.6, -23.6] |
| community full HTML ms | 100/100/100 | 42.1 (IQR 4.92, CV 29%) | 14.6 (IQR 3.65, CV 31%) | 16.1 (IQR 4.46, CV 27%) | -27.5 [-28.1, -26.2] | 1.49 [0.37, 2.53] | -26.0 [-26.9, -24.6] |
| profile full HTML ms | 100/100/100 | 53.9 (IQR 10.2, CV 16%) | 26.2 (IQR 6.83, CV 31%) | 27.2 (IQR 8.47, CV 26%) | -27.7 [-29.7, -25.8] | 0.98 [-0.80, 2.90] noise | -26.8 [-29.0, -24.3] |
| community-package full HTML ms | 100/100/100 | 49.5 (IQR 12.6, CV 31%) | 20.2 (IQR 4.91, CV 18%) | 22.7 (IQR 11.8, CV 41%) | -29.3 [-31.2, -27.2] | 2.53 [1.16, 5.05] | -26.7 [-28.7, -23.7] |
| account full HTML ms | 100/100/100 | 69.4 (IQR 10.5, CV 18%) | 40.0 (IQR 10.1, CV 28%) | 40.6 (IQR 10.3, CV 21%) | -29.3 [-31.8, -26.6] | 0.60 [-2.05, 3.83] noise | -28.7 [-31.5, -24.8] |
| jobs full HTML ms | 100/100/100 | 73.3 (IQR 14.7, CV 28%) | 41.1 (IQR 10.7, CV 20%) | 44.2 (IQR 10.6, CV 23%) | -32.2 [-34.7, -29.6] | 3.09 [0.22, 5.81] | -29.1 [-32.1, -26.0] |
| job-detail full HTML ms | 100/100/100 | 73.3 (IQR 14.1, CV 22%) | 42.1 (IQR 9.14, CV 20%) | 48.6 (IQR 10.7, CV 28%) | -31.2 [-33.4, -27.9] | 6.49 [3.06, 9.62] | -24.7 [-27.4, -21.5] |
| email full HTML ms | 100/100/100 | 81.2 (IQR 15.0, CV 21%) | 52.2 (IQR 12.3, CV 27%) | 57.2 (IQR 14.3, CV 19%) | -29.0 [-32.2, -26.0] | 4.94 [1.92, 7.70] | -24.0 [-27.6, -21.2] |
| email-message full HTML ms | 100/100/100 | 86.5 (IQR 16.7, CV 13%) | 59.3 (IQR 14.1, CV 19%) | 60.8 (IQR 15.4, CV 21%) | -27.1 [-32.2, -23.2] | 1.48 [-1.59, 6.78] noise | -25.7 [-30.8, -19.9] |
| credentials full HTML ms | 100/100/100 | 63.5 (IQR 10.2, CV 13%) | 33.1 (IQR 7.40, CV 21%) | 37.7 (IQR 8.17, CV 23%) | -30.3 [-32.5, -28.0] | 4.54 [3.16, 6.17] | -25.8 [-28.0, -23.4] |
| credential-detail full HTML ms | 100/100/100 | 91.9 (IQR 14.4, CV 20%) | 63.2 (IQR 14.6, CV 27%) | 67.7 (IQR 18.4, CV 22%) | -28.7 [-31.5, -25.1] | 4.56 [-0.72, 9.14] noise | -24.1 [-29.4, -18.4] |
| memories full HTML ms | 100/100/100 | 59.1 (IQR 7.64, CV 37%) | 30.0 (IQR 7.59, CV 22%) | 32.5 (IQR 8.85, CV 26%) | -29.1 [-30.4, -26.9] | 2.49 [0.66, 4.30] | -26.6 [-28.4, -24.3] |
| org-workspace full HTML ms | 100/100/100 | 59.2 (IQR 8.64, CV 15%) | 36.6 (IQR 11.5, CV 28%) | 34.5 (IQR 9.21, CV 44%) | -22.6 [-24.3, -20.4] | -2.13 [-4.09, -0.002] | -24.7 [-25.9, -22.9] |

**3c. HTML bytes per route**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| home HTML bytes | 100/100/100 | 195,011 (IQR 199, CV 0%) | 125,528 (IQR 220, CV 0%) | 126,242 (IQR 218, CV 0%) | -69,482 [-69,670, -69,318] | 714 [529, 900] | -68,769 [-68,954, -68,606] |
| pricing HTML bytes | 100/100/100 | 127,144 (IQR 0.00, CV 0%) | 59,127 (IQR 0.00, CV 0%) | 59,520 (IQR 0.00, CV 0%) | -68,017 [-68,017, -68,017] | 393 [393, 393] | -67,624 [-67,624, -67,624] |
| docs HTML bytes | 100/100/100 | 165,795 (IQR 0.00, CV 0%) | 92,585 (IQR 0.00, CV 0%) | 93,263 (IQR 0.00, CV 0%) | -73,210 [-73,210, -73,210] | 678 [678, 678] | -72,532 [-72,532, -72,532] |
| docs-deep HTML bytes | 100/100/100 | 528,772 (IQR 220, CV 0%) | 465,539 (IQR 196, CV 0%) | 467,928 (IQR 202, CV 0%) | -63,234 [-63,316, -63,180] | 2,388 [2,327, 2,473] | -60,845 [-60,888, -60,804] |
| blog HTML bytes | 100/100/100 | 122,110 (IQR 0.00, CV 0%) | 48,584 (IQR 0.50, CV 0%) | 49,116 (IQR 0.00, CV 0%) | -73,526 [-73,526, -73,526] | 532 [532, 532] | -72,994 [-72,994, -72,994] |
| blog-post HTML bytes | 100/100/100 | 128,355 (IQR 0.00, CV 0%) | 57,253 (IQR 0.00, CV 0%) | 57,725 (IQR 0.00, CV 0%) | -71,102 [-71,102, -71,102] | 472 [472, 472] | -70,630 [-70,630, -70,630] |
| community HTML bytes | 100/100/100 | 128,265 (IQR 0.00, CV 0%) | 62,876 (IQR 0.00, CV 0%) | 63,277 (IQR 2.00, CV 0%) | -65,389 [-65,389, -65,389] | 401 [401, 401] | -64,988 [-64,988, -64,988] |
| profile HTML bytes | 100/100/100 | 128,868 (IQR 0.00, CV 0%) | 62,049 (IQR 0.00, CV 0%) | 62,509 (IQR 0.00, CV 0%) | -66,819 [-66,819, -66,819] | 460 [460, 460] | -66,359 [-66,359, -66,359] |
| community-package HTML bytes | 100/100/100 | 133,251 (IQR 0.00, CV 0%) | 67,056 (IQR 0.00, CV 0%) | 67,586 (IQR 0.00, CV 0%) | -66,195 [-66,195, -66,195] | 530 [530, 530] | -65,665 [-65,665, -65,665] |
| account HTML bytes | 100/100/100 | 179,170 (IQR 0.00, CV 0%) | 103,502 (IQR 0.50, CV 0%) | 104,566 (IQR 0.50, CV 0%) | -75,668 [-75,668, -75,668] | 1,064 [1,064, 1,064] | -74,604 [-74,604, -74,604] |
| jobs HTML bytes | 100/100/100 | 207,731 (IQR 0.00, CV 0%) | 134,784 (IQR 0.00, CV 0%) | 136,188 (IQR 0.00, CV 0%) | -72,947 [-72,947, -72,947] | 1,404 [1,404, 1,404] | -71,543 [-71,543, -71,543] |
| job-detail HTML bytes | 100/100/100 | 224,258 (IQR 0.00, CV 0%) | 153,768 (IQR 0.00, CV 0%) | 155,283 (IQR 0.00, CV 0%) | -70,490 [-70,490, -70,490] | 1,515 [1,515, 1,515] | -68,975 [-68,975, -68,975] |
| email HTML bytes | 100/100/100 | 216,847 (IQR 0.00, CV 0%) | 145,826 (IQR 0.00, CV 0%) | 147,155 (IQR 0.00, CV 0%) | -71,021 [-71,021, -71,021] | 1,329 [1,329, 1,329] | -69,692 [-69,692, -69,692] |
| email-message HTML bytes | 100/100/100 | 234,136 (IQR 0.00, CV 0%) | 163,979 (IQR 0.00, CV 0%) | 165,492 (IQR 0.00, CV 0%) | -70,157 [-70,157, -70,157] | 1,513 [1,513, 1,513] | -68,644 [-68,644, -68,644] |
| credentials HTML bytes | 100/100/100 | 217,354 (IQR 0.00, CV 0%) | 144,960 (IQR 0.00, CV 0%) | 146,567 (IQR 0.00, CV 0%) | -72,394 [-72,394, -72,394] | 1,607 [1,607, 1,607] | -70,787 [-70,787, -70,787] |
| credential-detail HTML bytes | 100/100/100 | 226,548 (IQR 0.00, CV 0%) | 154,356 (IQR 0.00, CV 0%) | 156,009 (IQR 0.00, CV 0%) | -72,192 [-72,192, -72,192] | 1,653 [1,653, 1,653] | -70,539 [-70,539, -70,539] |
| memories HTML bytes | 100/100/100 | 204,515 (IQR 0.00, CV 0%) | 132,365 (IQR 0.00, CV 0%) | 133,689 (IQR 0.00, CV 0%) | -72,150 [-72,150, -72,150] | 1,324 [1,324, 1,324] | -70,826 [-70,826, -70,826] |
| org-workspace HTML bytes | 100/100/100 | 176,312 (IQR 0.00, CV 0%) | 119,515 (IQR 0.00, CV 0%) | 120,875 (IQR 0.00, CV 0%) | -56,797 [-56,797, -56,797] | 1,360 [1,360, 1,360] | -55,437 [-55,437, -55,437] |

**4. Navigation, all steps pooled, cpu1-hover0**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| all steps ready ms | 560/560/560 | 133 (IQR 125, CV 62%) | 158 (IQR 154, CV 65%) | 125 (IQR 158, CV 77%) | 25.5 [-0.50, 47.5] noise | -33.5 [-65.0, -2.99] | -8.00 [-37.5, 18.0] noise |
| flashes per navigation | 560/560/560 | 0.00 (IQR 0.00, CV 245%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| flash visible ms per navigation | 560/560/560 | 0.00 (IQR 0.00, CV 253%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| full reloads per navigation | 560/560/560 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| requests per navigation | 560/560/560 | 2.00 (IQR 2.00, CV 236%) | 5.00 (IQR 6.00, CV 173%) | 5.00 (IQR 6.00, CV 175%) | 3.00 [2.00, 4.00] | 0.00 [-2.00, 2.00] noise | 3.00 [2.00, 4.00] |
| bytes per navigation | 560/560/560 | 1,801 (IQR 101,019, CV 193%) | 5,606 (IQR 20,228, CV 201%) | 5,598 (IQR 20,510, CV 202%) | 3,805 [3,261, 3,873] | -8.00 [-495, 483] noise | 3,797 [3,254, 3,868] |
| long tasks per navigation | 560/560/560 | 0.00 (IQR 0.00, CV 276%) | 0.00 (IQR 1.00, CV 132%) | 0.00 (IQR 0.00, CV 219%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| long task ms per navigation | 560/560/560 | 0.00 (IQR 0.00, CV 281%) | 0.00 (IQR 59.0, CV 136%) | 0.00 (IQR 0.00, CV 224%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |

**4. Navigation, all steps pooled, cpu1-hover300**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| all steps ready ms | 560/560/560 | 85.0 (IQR 63.0, CV 48%) | 124 (IQR 100, CV 48%) | 96.0 (IQR 100, CV 59%) | 39.0 [31.5, 49.0] | -28.0 [-49.5, -13.0] | 11.0 [-9.00, 25.0] noise |
| flashes per navigation | 560/560/560 | 0.00 (IQR 0.00, CV 245%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| flash visible ms per navigation | 560/560/560 | 0.00 (IQR 0.00, CV 258%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| full reloads per navigation | 560/560/560 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| requests per navigation | 560/560/560 | 2.00 (IQR 2.00, CV 236%) | 5.00 (IQR 6.00, CV 171%) | 5.00 (IQR 6.00, CV 172%) | 3.00 [2.00, 4.00] | 0.00 [-2.00, 2.00] noise | 3.00 [2.00, 4.00] |
| bytes per navigation | 560/560/560 | 1,840 (IQR 101,019, CV 193%) | 5,978 (IQR 20,228, CV 200%) | 6,010 (IQR 20,516, CV 202%) | 4,138 [4,080, 4,278] | 31.5 [-82.0, 76.0] noise | 4,170 [4,069, 4,280] |
| long tasks per navigation | 560/560/560 | 0.00 (IQR 0.00, CV 245%) | 0.00 (IQR 1.00, CV 137%) | 0.00 (IQR 0.00, CV 224%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| long task ms per navigation | 560/560/560 | 0.00 (IQR 0.00, CV 250%) | 0.00 (IQR 56.0, CV 140%) | 0.00 (IQR 0.00, CV 228%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |

**4. Navigation, all steps pooled, cpu4-hover0**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| all steps ready ms | 560/560/560 | 257 (IQR 245, CV 59%) | 456 (IQR 312, CV 45%) | 273 (IQR 296, CV 57%) | 198 [159, 248] | -182 [-243, -110] | 16.0 [-41.0, 90.5] noise |
| flashes per navigation | 560/560/560 | 0.00 (IQR 0.00, CV 247%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| flash visible ms per navigation | 560/560/560 | 0.00 (IQR 0.00, CV 278%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| full reloads per navigation | 560/560/560 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| requests per navigation | 560/560/560 | 2.00 (IQR 2.00, CV 237%) | 5.00 (IQR 6.00, CV 174%) | 5.00 (IQR 6.00, CV 174%) | 3.00 [2.00, 4.00] | 0.00 [-2.00, 2.00] noise | 3.00 [2.00, 4.00] |
| bytes per navigation | 560/560/560 | 1,742 (IQR 101,019, CV 192%) | 5,368 (IQR 20,422, CV 175%) | 5,598 (IQR 20,509, CV 176%) | 3,626 [3,261, 3,873] | 230 [-495, 483] noise | 3,856 [3,254, 3,868] |
| long tasks per navigation | 560/560/560 | 1.00 (IQR 1.00, CV 77%) | 2.00 (IQR 2.00, CV 73%) | 1.00 (IQR 1.00, CV 74%) | 1.00 [1.00, 1.00] | -1.00 [-1.00, -1.00] | 0.00 [0.00, 0.00] noise |
| long task ms per navigation | 560/560/560 | 126 (IQR 100, CV 69%) | 255 (IQR 185, CV 62%) | 139 (IQR 136, CV 64%) | 128 [114, 142] | -116 [-130, -100] | 12.5 [2.50, 24.0] |

**4. Navigation, all steps pooled, cpu4-hover300**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| all steps ready ms | 560/560/560 | 234 (IQR 94.2, CV 42%) | 392 (IQR 269, CV 42%) | 222 (IQR 224, CV 52%) | 158 [144, 182] | -170 [-209, -137] | -11.5 [-43.0, 21.0] noise |
| flashes per navigation | 560/560/560 | 0.00 (IQR 0.00, CV 245%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| flash visible ms per navigation | 560/560/560 | 0.00 (IQR 0.00, CV 275%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| full reloads per navigation | 560/560/560 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| requests per navigation | 560/560/560 | 2.00 (IQR 2.00, CV 237%) | 5.00 (IQR 6.00, CV 172%) | 5.00 (IQR 6.00, CV 172%) | 3.00 [2.00, 4.00] | 0.00 [-2.00, 2.00] noise | 3.00 [2.00, 4.00] |
| bytes per navigation | 560/560/560 | 1,801 (IQR 101,019, CV 195%) | 6,011 (IQR 20,422, CV 174%) | 6,010 (IQR 20,512, CV 173%) | 4,210 [4,080, 4,281] | -1.00 [-85.0, 70.0] noise | 4,209 [4,069, 4,280] |
| long tasks per navigation | 560/560/560 | 1.00 (IQR 1.00, CV 59%) | 2.00 (IQR 1.00, CV 63%) | 1.00 (IQR 1.00, CV 67%) | 1.00 [1.00, 1.00] | -1.00 [-1.00, -1.00] | 0.00 [0.00, 0.00] noise |
| long task ms per navigation | 560/560/560 | 135 (IQR 95.0, CV 48%) | 319 (IQR 192, CV 52%) | 142 (IQR 134, CV 59%) | 184 [172, 196] | -176 [-190, -162] | 7.50 [-0.50, 18.0] noise |

**4b. Navigation per step, cpu1-hover0, click to destination content ready (ms)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| docs step0 click /docs/how-kody-works ready ms | 40/40/40 | 124 (IQR 23.5, CV 16%) | 169 (IQR 16.0, CV 10%) | 134 (IQR 24.0, CV 17%) | 45.5 [37.5, 49.5] | -35.0 [-42.0, -23.5] | 10.5 [2.00, 21.0] |
| docs step1 click /docs/kody-factory ready ms | 40/40/40 | 68.5 (IQR 8.25, CV 16%) | 125 (IQR 14.2, CV 10%) | 70.0 (IQR 14.2, CV 12%) | 56.5 [52.0, 59.5] | -55.0 [-58.0, -49.0] | 1.50 [-2.00, 7.00] noise |
| jobs step0 click /@user-me/-/jobs ready ms | 40/40/40 | 83.0 (IQR 3.25, CV 22%) | 98.0 (IQR 13.5, CV 16%) | 73.0 (IQR 12.5, CV 18%) | 15.0 [8.50, 17.5] | -25.0 [-30.5, -17.5] | -10.0 [-15.5, -6.00] |
| jobs step1 click /@user-me/-/jobs/bench-job-1 ready ms | 40/40/40 | 258 (IQR 53.5, CV 18%) | 419 (IQR 108, CV 17%) | 436 (IQR 111, CV 15%) | 161 [136, 212] | 16.5 [-41.0, 60.0] noise | 178 [148, 221] |
| jobs step2 click /@user-me/-/jobs/bench-job-2 ready ms | 40/40/40 | 207 (IQR 36.5, CV 17%) | 240 (IQR 33.2, CV 10%) | 232 (IQR 52.5, CV 20%) | 33.0 [21.0, 48.0] | -7.50 [-22.0, 15.5] noise | 25.5 [12.0, 49.0] |
| jobs step3 back /@user-me/-/jobs/bench-job-1 ready ms | 40/40/40 | 61.5 (IQR 14.2, CV 19%) | 81.5 (IQR 11.5, CV 12%) | 56.0 (IQR 17.2, CV 26%) | 20.0 [16.0, 26.0] | -25.5 [-32.0, -19.5] | -5.50 [-11.0, 1.00] noise |
| jobs step4 back /@user-me/-/jobs ready ms | 40/40/40 | 7.00 (IQR 2.00, CV 40%) | 36.5 (IQR 9.00, CV 18%) | 16.0 (IQR 3.00, CV 26%) | 29.5 [27.0, 32.0] | -20.5 [-23.0, -18.0] | 9.00 [8.00, 10.0] |
| email step0 click /@user-me/-/email/message ready ms | 40/40/40 | 168 (IQR 12.5, CV 9%) | 218 (IQR 39.8, CV 21%) | 189 (IQR 22.0, CV 14%) | 50.0 [41.0, 65.5] | -29.0 [-44.5, -20.5] | 21.0 [14.0, 24.5] |
| email step1 click /@user-me/-/email/message ready ms | 40/40/40 | 136 (IQR 24.0, CV 15%) | 120 (IQR 27.8, CV 30%) | 97.0 (IQR 29.2, CV 29%) | -15.5 [-26.5, -6.00] | -23.0 [-31.5, -12.0] | -38.5 [-46.0, -29.5] |
| email step2 filter ready ms | 40/40/40 | 37.5 (IQR 3.25, CV 15%) | 40.5 (IQR 6.50, CV 33%) | 28.5 (IQR 6.25, CV 41%) | 3.00 [1.50, 6.00] | -12.0 [-15.0, -9.00] | -9.00 [-10.0, -6.00] |
| credentials step0 click /@user-me/-/credentials/detail ready ms | 40/40/40 | 171 (IQR 15.5, CV 9%) | 259 (IQR 48.2, CV 16%) | 222 (IQR 39.8, CV 16%) | 88.0 [76.5, 109] | -36.5 [-58.5, -20.5] | 51.5 [42.5, 64.0] |
| marketing step0 click /pricing ready ms | 40/40/40 | 188 (IQR 22.5, CV 8%) | 199 (IQR 35.5, CV 14%) | 194 (IQR 27.2, CV 18%) | 11.0 [-2.00, 22.0] noise | -5.00 [-16.0, 7.00] noise | 6.00 [-4.00, 15.5] noise |
| marketing step1 click /docs ready ms | 40/40/40 | 290 (IQR 51.0, CV 12%) | 290 (IQR 52.5, CV 20%) | 300 (IQR 69.8, CV 16%) | 0.50 [-22.5, 20.5] noise | 9.50 [-13.0, 39.5] noise | 10.0 [-16.5, 43.0] noise |
| org-tabs step0 click /@bench-org/-/teams ready ms | 40/40/40 | 69.0 (IQR 17.0, CV 14%) | 83.0 (IQR 14.2, CV 14%) | 65.0 (IQR 7.00, CV 11%) | 14.0 [0.00, 20.5] noise | -18.0 [-24.5, -12.5] | -4.00 [-17.0, -2.00] |

**4c. Navigation per step, cpu4-hover0 (ms)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| docs step0 click /docs/how-kody-works ready ms | 40/40/40 | 421 (IQR 74.0, CV 26%) | 558 (IQR 85.8, CV 12%) | 404 (IQR 79.0, CV 17%) | 137 [101, 179] | -154 [-188, -117] | -17.0 [-45.0, 21.5] noise |
| docs step1 click /docs/kody-factory ready ms | 40/40/40 | 172 (IQR 28.5, CV 17%) | 428 (IQR 60.8, CV 15%) | 182 (IQR 33.0, CV 15%) | 256 [245, 273] | -246 [-266, -232] | 10.0 [-4.00, 24.0] noise |
| jobs step0 click /@user-me/-/jobs ready ms | 40/40/40 | 110 (IQR 14.5, CV 11%) | 336 (IQR 45.8, CV 11%) | 220 (IQR 35.2, CV 20%) | 226 [212, 244] | -117 [-140, -104] | 110 [93.0, 117] |
| jobs step1 click /@user-me/-/jobs/bench-job-1 ready ms | 40/40/40 | 480 (IQR 49.0, CV 8%) | 764 (IQR 96.2, CV 12%) | 578 (IQR 69.5, CV 12%) | 284 [261, 325] | -186 [-224, -156] | 98.0 [76.5, 130] |
| jobs step2 click /@user-me/-/jobs/bench-job-2 ready ms | 40/40/40 | 273 (IQR 68.5, CV 14%) | 506 (IQR 56.0, CV 12%) | 330 (IQR 63.5, CV 20%) | 232 [214, 264] | -175 [-210, -158] | 57.5 [34.0, 75.5] |
| jobs step3 back /@user-me/-/jobs/bench-job-1 ready ms | 40/40/40 | 120 (IQR 21.0, CV 16%) | 305 (IQR 36.2, CV 15%) | 138 (IQR 37.2, CV 24%) | 185 [174, 196] | -168 [-181, -149] | 17.5 [5.00, 34.5] |
| jobs step4 back /@user-me/-/jobs ready ms | 40/40/40 | 10.0 (IQR 2.25, CV 22%) | 150 (IQR 25.2, CV 16%) | 58.5 (IQR 18.2, CV 26%) | 140 [134, 152] | -91.5 [-104, -83.0] | 48.5 [43.0, 53.0] |
| email step0 click /@user-me/-/email/message ready ms | 40/40/40 | 312 (IQR 21.2, CV 8%) | 598 (IQR 85.2, CV 20%) | 398 (IQR 65.2, CV 15%) | 286 [255, 316] | -200 [-226, -160] | 86.5 [73.5, 115] |
| email step1 click /@user-me/-/email/message ready ms | 40/40/40 | 174 (IQR 40.5, CV 19%) | 244 (IQR 60.5, CV 22%) | 183 (IQR 35.5, CV 15%) | 69.5 [49.5, 87.0] | -61.0 [-81.0, -44.0] | 8.50 [-11.0, 20.0] noise |
| email step2 filter ready ms | 40/40/40 | 210 (IQR 41.8, CV 16%) | 216 (IQR 51.2, CV 26%) | 112 (IQR 27.0, CV 21%) | 5.50 [-13.0, 25.0] noise | -104 [-122, -92.0] | -98.5 [-116, -84.5] |
| credentials step0 click /@user-me/-/credentials/detail ready ms | 40/40/40 | 318 (IQR 34.2, CV 11%) | 666 (IQR 120, CV 18%) | 481 (IQR 79.5, CV 13%) | 348 [319, 399] | -184 [-242, -152] | 164 [146, 188] |
| marketing step0 click /pricing ready ms | 40/40/40 | 375 (IQR 61.2, CV 16%) | 498 (IQR 64.8, CV 13%) | 448 (IQR 85.2, CV 15%) | 122 [102, 154] | -49.5 [-101, -27.0] | 73.0 [30.5, 96.5] |
| marketing step1 click /docs ready ms | 40/40/40 | 482 (IQR 58.2, CV 17%) | 560 (IQR 79.8, CV 11%) | 532 (IQR 81.2, CV 15%) | 77.5 [51.0, 111] | -28.5 [-65.0, 4.50] noise | 49.0 [25.0, 77.5] |
| org-tabs step0 click /@bench-org/-/teams ready ms | 40/40/40 | 104 (IQR 24.2, CV 44%) | 254 (IQR 41.8, CV 13%) | 168 (IQR 31.0, CV 17%) | 150 [138, 168] | -86.0 [-104, -74.0] | 63.5 [52.0, 77.5] |

**6c. web-vitals over navigation sequences, cpu1-hover0**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| docs LCP | 40/40/40 | 324 (IQR 46.0, CV 15%) | 274 (IQR 63.0, CV 25%) | 268 (IQR 56.0, CV 17%) | -50.0 [-78.0, -34.0] | -6.00 [-22.0, 30.0] noise | -56.0 [-82.0, -22.0] |
| docs CLS | 40/40/40 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| docs INP | 40/40/40 | 88.0 (IQR 18.0, CV 15%) | 48.0 (IQR 8.00, CV 18%) | 24.0 (IQR 16.0, CV 33%) | -40.0 [-48.0, -32.0] | -24.0 [-28.0, -24.0] | -64.0 [-72.0, -56.0] |
| jobs LCP | 40/40/40 | 148 (IQR 27.0, CV 32%) | 110 (IQR 16.0, CV 15%) | 252 (IQR 42.0, CV 19%) | -38.0 [-50.0, -28.0] | 142 [126, 154] | 104 [86.0, 116] |
| jobs CLS | 40/40/40 | 0.20 (IQR 0.00, CV 34%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 632%) | -0.20 [-0.20, -0.20] | 0.00 [0.00, 0.00] noise | -0.20 [-0.20, -0.20] |
| jobs INP | 40/40/40 | 64.0 (IQR 24.0, CV 43%) | 88.0 (IQR 24.0, CV 22%) | 68.0 (IQR 40.0, CV 36%) | 24.0 [8.00, 32.0] | -20.0 [-32.0, 0.00] noise | 4.00 [-8.00, 24.0] noise |
| email LCP | 40/40/40 | 192 (IQR 36.0, CV 13%) | 164 (IQR 28.0, CV 15%) | 284 (IQR 60.0, CV 14%) | -28.0 [-40.0, -14.0] | 120 [106, 142] | 92.0 [78.0, 118] |
| email CLS | 40/40/40 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 632%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| email INP | 40/40/40 | 68.0 (IQR 36.0, CV 46%) | 96.0 (IQR 104, CV 53%) | 96.0 (IQR 80.0, CV 43%) | 28.0 [8.00, 76.0] | 0.00 [-48.0, 48.1] noise | 28.0 [8.00, 76.0] |
| credentials LCP | 40/40/40 | 160 (IQR 32.0, CV 15%) | 128 (IQR 25.0, CV 14%) | 256 (IQR 78.0, CV 24%) | -32.0 [-46.0, -22.0] | 128 [114, 148] | 96.0 [80.0, 116] |
| credentials CLS | 40/40/40 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| credentials INP | 40/40/40 | 64.0 (IQR 38.0, CV 48%) | 80.0 (IQR 34.0, CV 31%) | 52.0 (IQR 48.0, CV 48%) | 16.0 [3.90, 28.0] | -28.0 [-48.0, 0.00] noise | -12.0 [-32.0, 16.0] noise |
| marketing LCP | 40/40/40 | 196 (IQR 184, CV 37%) | 174 (IQR 29.0, CV 23%) | 320 (IQR 74.0, CV 19%) | -22.0 [-106, -10.0] | 146 [128, 168] | 124 [38.0, 146] |
| marketing CLS | 40/40/40 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| marketing INP | 40/40/40 | 88.0 (IQR 26.0, CV 27%) | 88.0 (IQR 20.0, CV 28%) | 88.0 (IQR 48.0, CV 39%) | 0.00 [-8.00, 12.0] noise | 0.00 [-12.0, 16.0] noise | 0.00 [-12.0, 16.0] noise |
| org-tabs LCP | 40/40/40 | 342 (IQR 59.0, CV 20%) | 124 (IQR 20.0, CV 18%) | 248 (IQR 46.0, CV 16%) | -218 [-236, -192] | 124 [108, 144] | -94.0 [-114, -60.0] |
| org-tabs CLS | 40/40/40 | 0.080 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | -0.080 [-0.080, -0.080] | 0.00 [0.00, 0.00] noise | -0.080 [-0.080, -0.080] |
| org-tabs INP | 40/40/40 | 48.0 (IQR 66.0, CV 55%) | 56.0 (IQR 24.0, CV 27%) | 32.0 (IQR 28.0, CV 52%) | 8.00 [-20.0, 16.0] noise | -24.0 [-32.0, -8.00] | -16.0 [-40.0, 0.00] noise |

**6c. web-vitals over navigation sequences, cpu4-hover0**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| docs LCP | 40/40/40 | 354 (IQR 82.0, CV 23%) | 320 (IQR 41.0, CV 17%) | 368 (IQR 34.0, CV 17%) | -34.0 [-56.0, -16.0] | 48.0 [36.0, 68.0] | 14.0 [-2.00, 32.0] noise |
| docs CLS | 40/40/40 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| docs INP | 40/40/40 | 296 (IQR 58.0, CV 23%) | 208 (IQR 34.0, CV 14%) | 60.0 (IQR 18.0, CV 23%) | -88.0 [-112, -80.0] | -148 [-152, -132] | -236 [-260, -228] |
| jobs LCP | 40/40/40 | 284 (IQR 54.0, CV 25%) | 250 (IQR 65.0, CV 18%) | 334 (IQR 31.0, CV 16%) | -34.0 [-64.0, -16.0] | 84.0 [64.0, 114] | 50.0 [32.0, 68.0] |
| jobs CLS | 40/40/40 | 0.20 (IQR 0.00, CV 0%) | 0.26 (IQR 0.00, CV 0%) | 0.00 (IQR 0.26, CV 146%) | 0.058 [0.058, 0.058] | -0.26 [-0.26, -0.26] | -0.20 [-0.20, -0.20] |
| jobs INP | 40/40/40 | 52.0 (IQR 32.0, CV 40%) | 216 (IQR 34.0, CV 15%) | 136 (IQR 24.0, CV 17%) | 164 [160, 176] | -80.0 [-96.0, -72.0] | 84.0 [68.0, 96.0] |
| email LCP | 40/40/40 | 334 (IQR 57.0, CV 22%) | 284 (IQR 57.0, CV 18%) | 364 (IQR 46.0, CV 16%) | -50.0 [-66.0, -28.0] | 80.0 [62.0, 100] | 30.0 [16.0, 56.0] |
| email CLS | 40/40/40 | 0.00 (IQR 0.00, CV 620%) | 0.000 (IQR 0.00, CV 380%) | 0.00 (IQR 0.000, CV 299%) | 0.000 [0.000, 0.000] | -0.000 [-0.000, -0.000] | 0.00 [0.00, 0.00] noise |
| email INP | 40/40/40 | 40.0 (IQR 8.00, CV 28%) | 216 (IQR 8.00, CV 23%) | 104 (IQR 26.0, CV 38%) | 176 [168, 180] | -112 [-120, -100] | 64.0 [52.0, 72.0] |
| credentials LCP | 40/40/40 | 298 (IQR 45.0, CV 17%) | 260 (IQR 56.0, CV 22%) | 330 (IQR 41.0, CV 13%) | -38.0 [-56.0, -16.0] | 70.0 [48.0, 88.0] | 32.0 [8.00, 52.0] |
| credentials CLS | 40/40/40 | 0.00 (IQR 0.00, CV 632%) | 0.00 (IQR 0.00, CV 441%) | 0.00 (IQR 0.00, CV 438%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| credentials INP | 40/40/40 | 80.0 (IQR 16.0, CV 24%) | 192 (IQR 32.0, CV 18%) | 112 (IQR 18.0, CV 21%) | 112 [92.0, 120] | -80.0 [-88.0, -64.0] | 32.0 [16.0, 40.0] |
| marketing LCP | 40/40/40 | 1,114 (IQR 152, CV 20%) | 642 (IQR 297, CV 32%) | 734 (IQR 112, CV 25%) | -472 [-560, -438] | 92.0 [42.0, 182] | -380 [-428, -342] |
| marketing CLS | 40/40/40 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| marketing INP | 40/40/40 | 88.0 (IQR 24.0, CV 19%) | 136 (IQR 24.0, CV 12%) | 92.0 (IQR 24.0, CV 25%) | 48.0 [40.0, 64.0] | -44.0 [-56.0, -36.0] | 4.00 [-4.00, 16.0] noise |
| org-tabs LCP | 40/40/40 | 756 (IQR 80.0, CV 14%) | 264 (IQR 58.0, CV 16%) | 352 (IQR 49.0, CV 12%) | -492 [-512, -464] | 88.0 [68.0, 112] | -404 [-424, -372] |
| org-tabs CLS | 40/40/40 | 0.080 (IQR 0.00, CV 4%) | 0.00 (IQR 0.00, CV 568%) | 0.00 (IQR 0.00, CV 578%) | -0.080 [-0.080, -0.080] | 0.00 [0.00, 0.00] noise | -0.080 [-0.080, -0.080] |
| org-tabs INP | 40/40/40 | 24.0 (IQR 38.0, CV 69%) | 160 (IQR 32.0, CV 15%) | 104 (IQR 10.0, CV 20%) | 136 [120, 144] | -56.0 [-72.0, -48.0] | 80.0 [64.0, 80.0] |

**5. Hydration, cpu1 (ms, long tasks as count)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| home mainThreadTaskMsUntilHydration | 40/40/40 | 165 (IQR 30.4, CV 27%) | 115 (IQR 31.3, CV 29%) | 147 (IQR 22.0, CV 28%) | -49.7 [-60.3, -34.3] | 31.8 [20.5, 42.0] | -17.9 [-26.1, -4.31] |
| home scriptEvaluationMsUntilHydration | 40/40/40 | 26.6 (IQR 4.46, CV 28%) | 5.93 (IQR 1.14, CV 86%) | 50.0 (IQR 8.96, CV 30%) | -20.6 [-21.7, -19.8] | 44.0 [41.2, 46.6] | 23.4 [20.4, 26.0] |
| home longTasksBeforeHydration | 40/40/40 | 1.00 (IQR 0.00, CV 34%) | 1.00 (IQR 0.00, CV 29%) | 0.00 (IQR 1.00, CV 162%) | 0.00 [0.00, 0.00] noise | -1.00 [-1.00, -1.00] | -1.00 [-1.00, -1.00] |
| home ScriptDuration | 40/40/40 | 33.0 (IQR 5.31, CV 11%) | 43.2 (IQR 10.8, CV 22%) | 96.5 (IQR 9.47, CV 30%) | 10.1 [4.40, 13.3] | 53.3 [49.6, 59.9] | 63.5 [60.1, 67.6] |
| home TaskDuration | 40/40/40 | 294 (IQR 28.8, CV 8%) | 334 (IQR 75.1, CV 17%) | 287 (IQR 34.4, CV 25%) | 40.2 [14.0, 65.3] | -47.1 [-73.4, -21.4] | -6.98 [-21.8, 5.78] noise |
| docs mainThreadTaskMsUntilHydration | 40/40/40 | 199 (IQR 22.1, CV 11%) | 221 (IQR 32.1, CV 16%) | 184 (IQR 52.0, CV 22%) | 22.7 [6.09, 31.4] | -37.3 [-50.3, -17.6] | -14.6 [-26.3, -1.26] |
| docs scriptEvaluationMsUntilHydration | 40/40/40 | 42.2 (IQR 3.95, CV 10%) | 38.0 (IQR 4.41, CV 17%) | 64.4 (IQR 16.8, CV 26%) | -4.15 [-6.25, -2.81] | 26.3 [19.9, 31.2] | 22.2 [15.4, 26.9] |
| docs longTasksBeforeHydration | 40/40/40 | 1.00 (IQR 0.00, CV 0%) | 1.00 (IQR 0.00, CV 15%) | 1.00 (IQR 1.00, CV 98%) | 0.00 [0.00, 0.00] noise | 0.00 [-1.00, 0.00] noise | 0.00 [-1.00, 0.00] noise |
| docs ScriptDuration | 40/40/40 | 46.1 (IQR 4.01, CV 10%) | 43.1 (IQR 7.28, CV 18%) | 118 (IQR 26.2, CV 22%) | -2.99 [-4.81, -1.01] | 74.9 [64.9, 81.7] | 71.9 [62.0, 78.4] |
| docs TaskDuration | 40/40/40 | 210 (IQR 19.7, CV 8%) | 236 (IQR 28.4, CV 14%) | 229 (IQR 60.3, CV 22%) | 25.6 [20.0, 36.0] | -7.16 [-24.9, 11.2] noise | 18.5 [3.53, 38.2] |
| account mainThreadTaskMsUntilHydration | 40/40/40 | 160 (IQR 16.8, CV 14%) | 176 (IQR 24.1, CV 11%) | 176 (IQR 33.2, CV 16%) | 16.1 [9.49, 25.6] | -0.83 [-13.3, 9.43] noise | 15.2 [5.55, 25.0] |
| account scriptEvaluationMsUntilHydration | 40/40/40 | 37.7 (IQR 5.83, CV 17%) | 32.4 (IQR 4.24, CV 15%) | 58.6 (IQR 13.2, CV 24%) | -5.35 [-7.27, -2.03] | 26.2 [20.5, 29.7] | 20.8 [15.3, 25.1] |
| account longTasksBeforeHydration | 40/40/40 | 1.00 (IQR 0.00, CV 15%) | 0.00 (IQR 0.00, CV 441%) | 1.00 (IQR 1.00, CV 74%) | -1.00 [-1.00, -1.00] | 1.00 [0.50, 1.00] | 0.00 [-0.50, 0.00] noise |
| account ScriptDuration | 40/40/40 | 44.3 (IQR 5.64, CV 12%) | 38.3 (IQR 5.38, CV 14%) | 105 (IQR 30.2, CV 17%) | -5.95 [-8.11, -2.55] | 66.6 [57.0, 72.2] | 60.6 [51.0, 66.6] |
| account TaskDuration | 40/40/40 | 170 (IQR 18.8, CV 9%) | 176 (IQR 23.2, CV 11%) | 211 (IQR 51.0, CV 16%) | 5.89 [-0.86, 15.4] noise | 34.6 [17.8, 46.1] | 40.5 [26.5, 51.9] |
| jobs mainThreadTaskMsUntilHydration | 40/40/40 | 145 (IQR 13.5, CV 10%) | 142 (IQR 18.2, CV 9%) | 137 (IQR 11.8, CV 15%) | -3.49 [-8.79, 6.76] noise | -4.39 [-11.8, 1.09] noise | -7.88 [-12.5, 0.32] noise |
| jobs scriptEvaluationMsUntilHydration | 40/40/40 | 40.8 (IQR 4.37, CV 12%) | 32.6 (IQR 4.26, CV 12%) | 51.2 (IQR 5.38, CV 26%) | -8.24 [-10.1, -6.41] | 18.6 [16.0, 21.1] | 10.3 [8.02, 12.4] |
| jobs longTasksBeforeHydration | 40/40/40 | 1.00 (IQR 0.00, CV 0%) | 0.00 (IQR 1.00, CV 146%) | 0.00 (IQR 1.00, CV 124%) | -1.00 [-1.00, -1.00] | 0.00 [0.00, 1.00] noise | -1.00 [-1.00, 0.00] noise |
| jobs ScriptDuration | 40/40/40 | 42.8 (IQR 4.28, CV 12%) | 39.9 (IQR 5.40, CV 12%) | 101 (IQR 13.1, CV 17%) | -2.90 [-4.87, -1.42] | 61.6 [58.5, 65.9] | 58.7 [55.7, 62.6] |
| jobs TaskDuration | 40/40/40 | 187 (IQR 21.1, CV 9%) | 189 (IQR 25.1, CV 10%) | 196 (IQR 22.6, CV 14%) | 2.15 [-8.69, 10.7] noise | 7.62 [-2.67, 19.1] noise | 9.77 [2.53, 16.9] |

**5. Hydration, cpu4 (ms, long tasks as count)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C |
|---|---|---|---|---|---|---|---|
| home mainThreadTaskMsUntilHydration | 20/20/20 | 636 (IQR 124, CV 24%) | 867 (IQR 146, CV 16%) | 751 (IQR 139, CV 17%) | 230 [166, 319] | -116 [-215, -33.7] | 115 [33.8, 198] |
| home scriptEvaluationMsUntilHydration | 20/20/20 | 80.9 (IQR 24.2, CV 30%) | 118 (IQR 12.7, CV 12%) | 209 (IQR 23.1, CV 12%) | 37.0 [20.7, 42.4] | 90.8 [79.0, 102] | 128 [110, 137] |
| home longTasksBeforeHydration | 20/20/20 | 3.00 (IQR 1.00, CV 26%) | 4.00 (IQR 1.25, CV 24%) | 3.00 (IQR 1.00, CV 18%) | 1.00 [0.00, 1.00] noise | -1.00 [-1.00, 0.50] noise | 0.00 [-0.50, 1.00] noise |
| home ScriptDuration | 20/20/20 | 123 (IQR 18.0, CV 18%) | 150 (IQR 31.8, CV 13%) | 322 (IQR 26.5, CV 10%) | 27.5 [11.8, 46.7] | 172 [149, 188] | 199 [182, 212] |
| home TaskDuration | 20/20/20 | 1,181 (IQR 143, CV 9%) | 1,197 (IQR 189, CV 11%) | 1,102 (IQR 106, CV 11%) | 15.3 [-62.2, 148] noise | -94.2 [-226, -33.7] | -78.8 [-161, -5.85] |
| docs mainThreadTaskMsUntilHydration | 20/20/20 | 771 (IQR 125, CV 23%) | 815 (IQR 105, CV 9%) | 646 (IQR 72.7, CV 8%) | 43.8 [-18.9, 89.8] noise | -168 [-223, -110] | -125 [-180, -84.9] |
| docs scriptEvaluationMsUntilHydration | 20/20/20 | 173 (IQR 13.7, CV 17%) | 144 (IQR 16.1, CV 10%) | 239 (IQR 25.8, CV 8%) | -28.7 [-37.7, -19.6] | 94.8 [76.5, 105] | 66.1 [47.6, 76.2] |
| docs longTasksBeforeHydration | 20/20/20 | 3.00 (IQR 1.00, CV 22%) | 3.00 (IQR 0.00, CV 13%) | 3.00 (IQR 0.25, CV 17%) | 0.00 [-1.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [-1.00, 0.00] noise |
| docs ScriptDuration | 20/20/20 | 167 (IQR 14.5, CV 8%) | 165 (IQR 26.4, CV 11%) | 405 (IQR 48.6, CV 9%) | -2.20 [-14.0, 15.3] noise | 239 [209, 262] | 237 [212, 258] |
| docs TaskDuration | 20/20/20 | 808 (IQR 65.8, CV 9%) | 848 (IQR 79.1, CV 9%) | 816 (IQR 92.0, CV 9%) | 39.8 [-18.0, 83.7] noise | -32.1 [-99.9, 14.6] noise | 7.66 [-59.5, 43.1] noise |
| account mainThreadTaskMsUntilHydration | 20/20/20 | 382 (IQR 24.5, CV 12%) | 701 (IQR 82.1, CV 14%) | 629 (IQR 72.0, CV 10%) | 319 [291, 357] | -72.4 [-126, -37.2] | 246 [207, 270] |
| account scriptEvaluationMsUntilHydration | 20/20/20 | 107 (IQR 11.6, CV 11%) | 138 (IQR 34.6, CV 16%) | 227 (IQR 40.9, CV 14%) | 31.1 [14.3, 47.0] | 88.5 [66.1, 112] | 120 [100, 136] |
| account longTasksBeforeHydration | 20/20/20 | 2.00 (IQR 0.25, CV 29%) | 3.00 (IQR 0.00, CV 25%) | 3.00 (IQR 1.00, CV 31%) | 1.00 [1.00, 1.00] | 0.00 [-1.00, 0.00] noise | 1.00 [0.00, 1.00] noise |
| account ScriptDuration | 20/20/20 | 150 (IQR 13.0, CV 9%) | 154 (IQR 25.6, CV 13%) | 358 (IQR 65.9, CV 12%) | 3.83 [-6.85, 18.5] noise | 204 [183, 240] | 208 [190, 243] |
| account TaskDuration | 20/20/20 | 635 (IQR 32.9, CV 9%) | 705 (IQR 71.7, CV 14%) | 753 (IQR 76.8, CV 10%) | 70.0 [41.3, 102] | 47.8 [1.52, 86.4] | 118 [74.9, 147] |
| jobs mainThreadTaskMsUntilHydration | 20/20/20 | 462 (IQR 42.0, CV 11%) | 528 (IQR 61.4, CV 10%) | 509 (IQR 70.1, CV 15%) | 65.4 [34.3, 97.9] | -18.1 [-45.7, 28.9] noise | 47.4 [28.8, 87.9] |
| jobs scriptEvaluationMsUntilHydration | 20/20/20 | 147 (IQR 13.7, CV 17%) | 123 (IQR 9.46, CV 9%) | 209 (IQR 31.3, CV 19%) | -24.3 [-31.8, -16.6] | 86.2 [70.6, 94.8] | 61.9 [45.4, 71.5] |
| jobs longTasksBeforeHydration | 20/20/20 | 2.00 (IQR 0.00, CV 11%) | 2.00 (IQR 0.00, CV 0%) | 2.00 (IQR 0.00, CV 11%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise |
| jobs ScriptDuration | 20/20/20 | 155 (IQR 14.6, CV 13%) | 150 (IQR 14.7, CV 9%) | 350 (IQR 52.8, CV 12%) | -5.13 [-10.7, 5.65] noise | 200 [184, 224] | 195 [179, 220] |
| jobs TaskDuration | 20/20/20 | 723 (IQR 55.1, CV 9%) | 722 (IQR 87.0, CV 8%) | 735 (IQR 124, CV 13%) | -0.86 [-37.2, 53.0] noise | 13.4 [-49.7, 81.2] noise | 12.6 [-35.6, 81.9] noise |

**6a. Lighthouse mobile scores (0 to 100)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C | range A / B / C |
|---|---|---|---|---|---|---|---|---|
| home performance | 5/5/5 | 75.0 (IQR 4.00, CV 3%) | 98.0 (IQR 7.00, CV 4%) | 100 (IQR 0.00, CV 0%) | 23.0 [16.0, 27.0] | 2.00 [1.00, 8.00] | 25.0 [23.0, 28.0] | 72.0 to 77.0 / 92.0 to 99.0 / 99.0 to 100 |
| home accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| home bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| home seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| pricing performance | 5/5/5 | 100 (IQR 1.00, CV 1%) | 99.0 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | -1.00 [-1.00, 0.00] noise | 1.00 [1.00, 1.00] | 0.00 [0.00, 1.00] noise | 99.0 to 100 / 99.0 to 99.0 / 100 to 100 |
| pricing accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| pricing bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| pricing seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| docs performance | 5/5/5 | 95.0 (IQR 0.00, CV 0%) | 91.0 (IQR 4.00, CV 3%) | 96.0 (IQR 4.00, CV 4%) | -4.00 [-7.00, 0.00] noise | 5.00 [-3.00, 8.00] noise | 1.00 [-7.00, 1.00] noise | 95.0 to 96.0 / 88.0 to 95.0 / 88.0 to 96.0 |
| docs accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| docs bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| docs seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| docs-deep performance | 5/5/5 | 58.0 (IQR 1.00, CV 3%) | 64.0 (IQR 8.00, CV 7%) | 77.0 (IQR 1.00, CV 1%) | 6.00 [-2.00, 8.00] noise | 13.0 [11.0, 21.0] | 19.0 [17.0, 21.0] | 56.0 to 60.0 / 56.0 to 64.0 / 75.0 to 77.0 |
| docs-deep accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| docs-deep bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| docs-deep seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| blog performance | 5/5/5 | 76.0 (IQR 1.00, CV 1%) | 84.0 (IQR 2.00, CV 2%) | 86.0 (IQR 0.00, CV 1%) | 8.00 [5.00, 9.00] | 2.00 [1.00, 5.00] | 10.0 [9.00, 11.0] | 75.0 to 76.0 / 81.0 to 84.0 / 85.0 to 87.0 |
| blog accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| blog bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| blog seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| blog-post performance | 5/5/5 | 96.0 (IQR 2.00, CV 1%) | 97.0 (IQR 1.00, CV 1%) | 100 (IQR 0.00, CV 0%) | 1.00 [-1.00, 2.00] noise | 3.00 [2.00, 3.00] | 4.00 [2.00, 4.00] | 96.0 to 98.0 / 97.0 to 98.0 / 99.0 to 100 |
| blog-post accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| blog-post bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| blog-post seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| community performance | 5/5/5 | 83.0 (IQR 0.00, CV 2%) | 99.0 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 16.0 [15.0, 19.0] | 1.00 [0.00, 2.00] noise | 17.0 [16.0, 20.0] | 80.0 to 84.0 / 98.0 to 99.0 / 99.0 to 100 |
| community accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| community bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| community seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| profile performance | 5/5/5 | 100 (IQR 1.00, CV 1%) | 98.0 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | -2.00 [-3.00, -1.00] | 2.00 [1.00, 3.00] | 0.00 [-1.00, 1.00] noise | 99.0 to 100 / 97.0 to 98.0 / 99.0 to 100 |
| profile accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| profile bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| profile seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| community-package performance | 5/5/5 | 98.0 (IQR 0.00, CV 1%) | 97.0 (IQR 1.00, CV 1%) | 100 (IQR 0.00, CV 0%) | -1.00 [-3.00, 1.00] noise | 3.00 [2.00, 5.00] | 2.00 [1.00, 4.00] | 96.0 to 99.0 / 95.0 to 97.0 / 99.0 to 100 |
| community-package accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| community-package bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| community-package seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| account performance | 5/5/5 | 100 (IQR 0.00, CV 0%) | 95.0 (IQR 3.00, CV 4%) | 100 (IQR 0.00, CV 0%) | -5.00 [-13.0, -4.00] | 5.00 [4.00, 13.0] | 0.00 [-1.00, 0.00] noise | 100 to 100 / 87.0 to 96.0 / 99.0 to 100 |
| account accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| account bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| account seo | 5/5/5 | 58.0 (IQR 0.00, CV 0%) | 58.0 (IQR 0.00, CV 0%) | 58.0 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 58.0 to 58.0 / 58.0 to 58.0 / 58.0 to 58.0 |

**6b. Lighthouse mobile timings (ms, CLS unitless)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C | range A / B / C |
|---|---|---|---|---|---|---|---|---|
| home LCP | 5/5/5 | 5,292 (IQR 46.0, CV 0%) | 1,151 (IQR 52.6, CV 2%) | 1,141 (IQR 21.9, CV 2%) | -4,140 [-4,193, -4,093] | -10.8 [-69.2, 15.8] noise | -4,151 [-4,208, -4,124] | 5,287 to 5,335 / 1,137 to 1,196 / 1,125 to 1,167 |
| home FCP | 5/5/5 | 1,013 (IQR 52.4, CV 3%) | 1,151 (IQR 52.6, CV 2%) | 1,141 (IQR 21.9, CV 2%) | 139 [118, 229] | -10.8 [-69.2, 15.8] noise | 128 [105, 184] | 965 to 1,027 / 1,137 to 1,196 / 1,125 to 1,167 |
| home CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| home TBT | 5/5/5 | 270 (IQR 106, CV 21%) | 141 (IQR 209, CV 51%) | 52.5 (IQR 9.00, CV 15%) | -129 [-211, 115] noise | -88.5 [-296, -72.5] | -217 [-300, -163] | 222 to 352 / 137 to 347 / 48.0 to 68.5 |
| home SpeedIndex | 5/5/5 | 1,513 (IQR 95.4, CV 4%) | 1,659 (IQR 230, CV 9%) | 2,099 (IQR 28.1, CV 6%) | 145 [29.9, 450] | 440 [203, 693] | 585 [544, 838] | 1,417 to 1,555 / 1,543 to 1,873 / 2,069 to 2,351 |
| pricing LCP | 5/5/5 | 997 (IQR 13.5, CV 2%) | 993 (IQR 17.2, CV 1%) | 969 (IQR 18.1, CV 1%) | -4.19 [-23.2, 23.7] noise | -23.4 [-34.1, 4.27] noise | -27.5 [-46.5, 0.31] noise | 969 to 1,016 / 979 to 1,001 / 965 to 987 |
| pricing FCP | 5/5/5 | 997 (IQR 13.5, CV 2%) | 993 (IQR 17.2, CV 1%) | 969 (IQR 18.1, CV 1%) | -4.19 [-23.2, 23.7] noise | -23.4 [-34.1, 4.27] noise | -27.5 [-46.5, 0.31] noise | 969 to 1,016 / 979 to 1,001 / 965 to 987 |
| pricing CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| pricing TBT | 5/5/5 | 90.2 (IQR 20.0, CV 16%) | 103 (IQR 16.5, CV 18%) | 52.5 (IQR 3.00, CV 5%) | 12.8 [-11.9, 57.3] noise | -50.6 [-95.0, -45.1] | -37.7 [-62.5, -25.5] | 79.0 to 115 / 101 to 147 / 52.5 to 58.0 |
| pricing SpeedIndex | 5/5/5 | 1,826 (IQR 58.2, CV 7%) | 1,356 (IQR 24.2, CV 2%) | 969 (IQR 18.1, CV 1%) | -470 [-499, -177] | -387 [-433, -360] | -857 [-879, -564] | 1,533 to 1,848 / 1,338 to 1,403 / 965 to 987 |
| docs LCP | 5/5/5 | 1,021 (IQR 22.2, CV 3%) | 1,138 (IQR 1.86, CV 1%) | 1,145 (IQR 8.04, CV 1%) | 117 [52.0, 145] | 6.89 [-20.9, 41.1] noise | 124 [58.9, 158] | 1,001 to 1,086 / 1,136 to 1,165 / 1,137 to 1,179 |
| docs FCP | 5/5/5 | 1,021 (IQR 22.2, CV 3%) | 1,138 (IQR 1.86, CV 1%) | 1,145 (IQR 8.04, CV 1%) | 117 [52.0, 145] | 6.89 [-20.9, 41.1] noise | 124 [58.9, 158] | 1,001 to 1,086 / 1,136 to 1,165 / 1,137 to 1,179 |
| docs CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| docs TBT | 5/5/5 | 264 (IQR 25.0, CV 8%) | 389 (IQR 102, CV 25%) | 236 (IQR 99.0, CV 37%) | 125 [-1.00, 224] noise | -154 [-253, 90.3] noise | -28.5 [-44.0, 216] noise | 226 to 272 / 263 to 488 / 220 to 480 |
| docs SpeedIndex | 5/5/5 | 1,021 (IQR 22.2, CV 3%) | 1,138 (IQR 1.86, CV 1%) | 1,145 (IQR 8.04, CV 1%) | 117 [52.0, 145] | 6.89 [-20.9, 41.1] noise | 124 [58.9, 158] | 1,001 to 1,086 / 1,136 to 1,165 / 1,137 to 1,179 |
| docs-deep LCP | 5/5/5 | 7,480 (IQR 149, CV 1%) | 6,242 (IQR 463, CV 4%) | 5,094 (IQR 81.7, CV 1%) | -1,238 [-1,508, -891] | -1,149 [-1,464, -914] | -2,386 [-2,506, -2,225] | 7,370 to 7,582 / 6,065 to 6,534 / 5,068 to 5,200 |
| docs-deep FCP | 5/5/5 | 1,157 (IQR 10.4, CV 1%) | 1,299 (IQR 25.6, CV 1%) | 1,297 (IQR 24.3, CV 1%) | 142 [114, 172] | -1.85 [-31.8, 31.7] noise | 140 [112, 174] | 1,154 to 1,185 / 1,293 to 1,329 / 1,292 to 1,331 |
| docs-deep CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| docs-deep TBT | 5/5/5 | 749 (IQR 30.0, CV 10%) | 554 (IQR 452, CV 35%) | 223 (IQR 39.0, CV 14%) | -195 [-274, 238] noise | -330 [-771, -250] | -526 [-593, -402] | 625 to 816 / 503 to 985 / 200 to 283 |
| docs-deep SpeedIndex | 5/5/5 | 1,247 (IQR 79.7, CV 6%) | 1,299 (IQR 25.6, CV 1%) | 1,297 (IQR 24.3, CV 1%) | 52.6 [-43.1, 142] noise | -1.85 [-31.8, 31.7] noise | 50.8 [-44.9, 140] noise | 1,157 to 1,342 / 1,293 to 1,329 / 1,292 to 1,331 |
| blog LCP | 5/5/5 | 6,614 (IQR 15.1, CV 1%) | 4,407 (IQR 23.6, CV 1%) | 4,155 (IQR 39.5, CV 3%) | -2,208 [-2,273, -2,143] | -252 [-363, -72.6] | -2,460 [-2,571, -2,280] | 6,591 to 6,680 / 4,386 to 4,472 / 4,044 to 4,334 |
| blog FCP | 5/5/5 | 984 (IQR 11.0, CV 1%) | 985 (IQR 4.44, CV 2%) | 977 (IQR 40.6, CV 2%) | 0.83 [-17.3, 42.8] noise | -8.07 [-50.1, 37.4] noise | -7.25 [-24.4, 34.9] noise | 980 to 999 / 974 to 1,027 / 968 to 1,019 |
| blog CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| blog TBT | 5/5/5 | 144 (IQR 38.0, CV 15%) | 140 (IQR 76.0, CV 29%) | 63.0 (IQR 8.00, CV 26%) | -4.50 [-65.0, 63.0] noise | -76.5 [-143, -43.0] | -81.0 [-123, -47.5] | 128 to 180 / 109 to 207 / 52.0 to 96.5 |
| blog SpeedIndex | 5/5/5 | 1,476 (IQR 64.7, CV 10%) | 1,495 (IQR 50.2, CV 12%) | 1,641 (IQR 667, CV 28%) | 19.0 [-292, 419] noise | 146 [-499, 455] noise | 165 [-470, 474] noise | 1,397 to 1,787 / 1,437 to 1,894 / 1,019 to 1,950 |
| blog-post LCP | 5/5/5 | 975 (IQR 51.8, CV 4%) | 978 (IQR 9.92, CV 1%) | 986 (IQR 10.4, CV 1%) | 3.20 [-81.8, 15.6] noise | 8.39 [-2.54, 21.5] noise | 11.6 [-73.4, 25.7] noise | 969 to 1,060 / 973 to 989 / 983 to 996 |
| blog-post FCP | 5/5/5 | 975 (IQR 51.8, CV 4%) | 978 (IQR 9.92, CV 1%) | 986 (IQR 10.4, CV 1%) | 3.20 [-81.8, 15.6] noise | 8.39 [-2.54, 21.5] noise | 11.6 [-73.4, 25.7] noise | 969 to 1,060 / 973 to 989 / 983 to 996 |
| blog-post CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| blog-post TBT | 5/5/5 | 216 (IQR 58.8, CV 16%) | 183 (IQR 14.5, CV 7%) | 63.0 (IQR 16.5, CV 28%) | -33.0 [-69.3, 14.3] noise | -120 [-132, -74.5] | -153 [-183, -90.4] | 169 to 246 / 163 to 194 / 59.0 to 108 |
| blog-post SpeedIndex | 5/5/5 | 975 (IQR 51.8, CV 4%) | 978 (IQR 9.92, CV 1%) | 986 (IQR 10.4, CV 1%) | 3.20 [-81.8, 15.6] noise | 8.39 [-2.54, 21.5] noise | 11.6 [-73.4, 25.7] noise | 969 to 1,060 / 973 to 989 / 983 to 996 |
| community LCP | 5/5/5 | 4,649 (IQR 41.0, CV 1%) | 985 (IQR 12.0, CV 1%) | 987 (IQR 4.33, CV 1%) | -3,664 [-3,774, -3,633] | 2.21 [-16.3, 13.4] noise | -3,662 [-3,772, -3,634] | 4,621 to 4,759 / 974 to 1,003 / 977 to 995 |
| community FCP | 5/5/5 | 977 (IQR 16.5, CV 1%) | 985 (IQR 12.0, CV 1%) | 987 (IQR 4.33, CV 1%) | 7.91 [-7.54, 26.4] noise | 2.21 [-16.3, 13.4] noise | 10.1 [-4.54, 23.2] noise | 964 to 990 / 974 to 1,003 / 977 to 995 |
| community CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| community TBT | 5/5/5 | 78.5 (IQR 26.0, CV 49%) | 131 (IQR 29.3, CV 22%) | 62.5 (IQR 8.00, CV 36%) | 52.6 [-50.9, 89.1] noise | -68.6 [-105, -20.1] | -16.0 [-120, 32.5] noise | 58.5 to 182 / 92.5 to 168 / 50.5 to 111 |
| community SpeedIndex | 5/5/5 | 1,303 (IQR 48.9, CV 3%) | 985 (IQR 12.0, CV 1%) | 987 (IQR 4.33, CV 1%) | -319 [-339, -259] | 2.21 [-16.3, 13.4] noise | -316 [-337, -261] | 1,248 to 1,324 / 974 to 1,003 / 977 to 995 |
| profile LCP | 5/5/5 | 970 (IQR 15.1, CV 1%) | 977 (IQR 6.84, CV 1%) | 978 (IQR 10.8, CV 1%) | 6.99 [-9.90, 20.0] noise | 1.39 [-11.7, 15.8] noise | 8.38 [-6.70, 23.1] noise | 965 to 985 / 972 to 990 / 977 to 990 |
| profile FCP | 5/5/5 | 970 (IQR 15.1, CV 1%) | 977 (IQR 6.84, CV 1%) | 978 (IQR 10.8, CV 1%) | 6.99 [-9.90, 20.0] noise | 1.39 [-11.7, 15.8] noise | 8.38 [-6.70, 23.1] noise | 965 to 985 / 972 to 990 / 977 to 990 |
| profile CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| profile TBT | 5/5/5 | 73.5 (IQR 46.5, CV 33%) | 163 (IQR 17.5, CV 13%) | 65.0 (IQR 9.00, CV 34%) | 89.5 [48.2, 134] | -98.0 [-143, -45.5] | -8.50 [-49.5, 44.0] noise | 53.0 to 112 / 150 to 208 / 57.5 to 118 |
| profile SpeedIndex | 5/5/5 | 1,378 (IQR 38.2, CV 3%) | 977 (IQR 6.84, CV 1%) | 978 (IQR 10.8, CV 1%) | -401 [-428, -337] | 1.39 [-11.7, 15.8] noise | -400 [-426, -335] | 1,314 to 1,405 / 972 to 990 / 977 to 990 |
| community-package LCP | 5/5/5 | 972 (IQR 2.29, CV 1%) | 1,130 (IQR 7.13, CV 1%) | 1,132 (IQR 0.41, CV 0%) | 157 [141, 167] | 2.24 [-7.66, 9.24] noise | 159 [143, 166] | 969 to 989 / 1,124 to 1,139 / 1,126 to 1,139 |
| community-package FCP | 5/5/5 | 972 (IQR 2.29, CV 1%) | 1,130 (IQR 7.13, CV 1%) | 1,132 (IQR 0.41, CV 0%) | 157 [141, 167] | 2.24 [-7.66, 9.24] noise | 159 [143, 166] | 969 to 989 / 1,124 to 1,139 / 1,126 to 1,139 |
| community-package CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| community-package TBT | 5/5/5 | 160 (IQR 6.00, CV 22%) | 208 (IQR 42.0, CV 12%) | 69.0 (IQR 11.5, CV 24%) | 48.5 [-15.0, 87.0] noise | -139 [-176, -107] | -91.0 [-154, -52.5] | 122 to 223 / 188 to 245 / 57.5 to 102 |
| community-package SpeedIndex | 5/5/5 | 972 (IQR 2.29, CV 1%) | 1,130 (IQR 7.13, CV 1%) | 1,132 (IQR 0.41, CV 0%) | 157 [141, 167] | 2.24 [-7.66, 9.24] noise | 159 [143, 166] | 969 to 989 / 1,124 to 1,139 / 1,126 to 1,139 |
| account LCP | 5/5/5 | 983 (IQR 8.57, CV 1%) | 1,135 (IQR 26.1, CV 2%) | 1,132 (IQR 27.1, CV 2%) | 153 [140, 191] | -3.24 [-41.2, 34.9] noise | 150 [143, 187] | 971 to 989 / 1,123 to 1,173 / 1,128 to 1,167 |
| account FCP | 5/5/5 | 983 (IQR 8.57, CV 1%) | 1,135 (IQR 26.1, CV 2%) | 1,132 (IQR 27.1, CV 2%) | 153 [140, 191] | -3.24 [-41.2, 34.9] noise | 150 [143, 187] | 971 to 989 / 1,123 to 1,173 / 1,128 to 1,167 |
| account CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| account TBT | 5/5/5 | 49.5 (IQR 8.00, CV 14%) | 255 (IQR 92.7, CV 38%) | 69.5 (IQR 9.00, CV 17%) | 206 [170, 460] | -186 [-440, -147] | 20.0 [7.00, 43.0] | 43.5 to 62.5 / 220 to 510 / 63.0 to 92.5 |
| account SpeedIndex | 5/5/5 | 1,830 (IQR 10.5, CV 1%) | 1,135 (IQR 26.1, CV 2%) | 1,132 (IQR 27.1, CV 2%) | -695 [-743, -657] | -3.24 [-41.2, 34.9] noise | -698 [-747, -661] | 1,820 to 1,879 / 1,123 to 1,173 / 1,128 to 1,167 |

**6a. Lighthouse desktop scores (0 to 100)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C | range A / B / C |
|---|---|---|---|---|---|---|---|---|
| home performance | 5/5/5 | 98.0 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 2.00 [2.00, 2.00] | 0.00 [0.00, 0.00] noise | 2.00 [2.00, 2.00] | 98.0 to 98.0 / 100 to 100 / 100 to 100 |
| home accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| home bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| home seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| pricing performance | 5/5/5 | 98.0 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 2.00 [2.00, 2.00] | 0.00 [0.00, 0.00] noise | 2.00 [2.00, 2.00] | 98.0 to 98.0 / 100 to 100 / 100 to 100 |
| pricing accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| pricing bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| pricing seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| docs performance | 5/5/5 | 94.0 (IQR 1.00, CV 1%) | 95.0 (IQR 0.00, CV 1%) | 97.0 (IQR 0.00, CV 0%) | 1.00 [0.00, 3.00] noise | 2.00 [1.00, 3.00] | 3.00 [2.00, 5.00] | 92.0 to 94.0 / 94.0 to 96.0 / 96.0 to 97.0 |
| docs accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| docs bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| docs seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| docs-deep performance | 5/5/5 | 91.0 (IQR 2.00, CV 2%) | 94.0 (IQR 1.00, CV 2%) | 97.0 (IQR 0.00, CV 0%) | 3.00 [0.00, 6.00] noise | 3.00 [2.00, 6.00] | 6.00 [5.00, 9.00] | 88.0 to 92.0 / 91.0 to 95.0 / 97.0 to 98.0 |
| docs-deep accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| docs-deep bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| docs-deep seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| blog performance | 5/5/5 | 98.0 (IQR 1.00, CV 1%) | 98.0 (IQR 0.00, CV 0%) | 98.0 (IQR 0.00, CV 0%) | 0.00 [0.00, 2.00] noise | 0.00 [0.00, 1.00] noise | 0.00 [0.00, 2.00] noise | 96.0 to 98.0 / 98.0 to 98.0 / 98.0 to 99.0 |
| blog accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| blog bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| blog seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| blog-post performance | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| blog-post accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| blog-post bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| blog-post seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| community performance | 5/5/5 | 98.0 (IQR 1.00, CV 1%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 2.00 [1.00, 2.00] | 0.00 [0.00, 0.00] noise | 2.00 [1.00, 2.00] | 98.0 to 99.0 / 100 to 100 / 100 to 100 |
| community accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| community bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| community seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| profile performance | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| profile accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| profile bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| profile seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| community-package performance | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| community-package accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| community-package bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| community-package seo | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| account performance | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| account accessibility | 5/5/5 | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 100 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 100 to 100 / 100 to 100 / 100 to 100 |
| account bestPractices | 5/5/5 | 100 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | 96.0 (IQR 0.00, CV 0%) | -4.00 [-4.00, -4.00] | 0.00 [0.00, 0.00] noise | -4.00 [-4.00, -4.00] | 100 to 100 / 96.0 to 96.0 / 96.0 to 96.0 |
| account seo | 5/5/5 | 58.0 (IQR 0.00, CV 0%) | 58.0 (IQR 0.00, CV 0%) | 58.0 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 58.0 to 58.0 / 58.0 to 58.0 / 58.0 to 58.0 |

**6b. Lighthouse desktop timings (ms, CLS unitless)**

| metric | n A/B/C | A | B | C | A to B | B to C | A to C | range A / B / C |
|---|---|---|---|---|---|---|---|---|
| home LCP | 5/5/5 | 1,095 (IQR 42.6, CV 3%) | 322 (IQR 0.27, CV 2%) | 314 (IQR 3.27, CV 3%) | -773 [-795, -728] | -8.30 [-22.3, -1.09] | -781 [-804, -736] | 1,050 to 1,117 / 315 to 329 / 300 to 321 |
| home FCP | 5/5/5 | 273 (IQR 9.91, CV 2%) | 322 (IQR 0.27, CV 2%) | 314 (IQR 3.27, CV 3%) | 48.7 [39.9, 56.2] | -8.30 [-22.3, -1.09] | 40.4 [26.4, 50.1] | 266 to 282 / 315 to 329 / 300 to 321 |
| home CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| home TBT | 5/5/5 | 26.0 (IQR 15.0, CV 43%) | 0.00 (IQR 0.00, CV 224%) | 0.00 (IQR 0.00, CV 0%) | -26.0 [-48.0, -18.0] | 0.00 [-5.50, 0.00] noise | -26.0 [-48.0, -18.0] | 18.0 to 48.0 / 0.00 to 5.50 / 0.00 to 0.00 |
| home SpeedIndex | 5/5/5 | 464 (IQR 46.2, CV 5%) | 498 (IQR 37.7, CV 6%) | 597 (IQR 19.8, CV 5%) | 34.1 [-7.98, 77.8] noise | 98.7 [62.9, 150] | 133 [93.5, 182] | 451 to 499 / 462 to 530 / 570 to 646 |
| pricing LCP | 5/5/5 | 1,137 (IQR 3.19, CV 1%) | 283 (IQR 21.2, CV 5%) | 279 (IQR 2.28, CV 1%) | -854 [-875, -829] | -3.85 [-29.4, 6.39] noise | -858 [-879, -848] | 1,127 to 1,158 / 274 to 309 / 274 to 283 |
| pricing FCP | 5/5/5 | 280 (IQR 5.22, CV 1%) | 283 (IQR 21.2, CV 5%) | 279 (IQR 2.28, CV 1%) | 3.43 [-6.36, 29.0] noise | -3.85 [-29.4, 6.39] noise | -0.42 [-5.81, 5.56] noise | 275 to 281 / 274 to 309 / 274 to 283 |
| pricing CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| pricing TBT | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 2.00, CV 153%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 4.50] noise | 0.00 [-4.50, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 4.50 / 0.00 to 0.00 |
| pricing SpeedIndex | 5/5/5 | 501 (IQR 11.8, CV 5%) | 445 (IQR 38.2, CV 14%) | 299 (IQR 17.5, CV 11%) | -55.7 [-102, 63.6] noise | -146 [-266, -76.4] | -202 [-243, -132] | 474 to 542 / 399 to 564 / 283 to 369 |
| docs LCP | 5/5/5 | 1,599 (IQR 120, CV 4%) | 1,490 (IQR 11.9, CV 2%) | 1,317 (IQR 111, CV 8%) | -109 [-235, -77.1] | -173 [-277, -28.5] | -282 [-494, -137] | 1,583 to 1,716 / 1,449 to 1,522 / 1,216 to 1,461 |
| docs FCP | 5/5/5 | 300 (IQR 25.3, CV 5%) | 327 (IQR 3.39, CV 2%) | 324 (IQR 4.04, CV 1%) | 26.5 [-7.52, 41.9] noise | -2.99 [-18.3, 2.28] noise | 23.5 [-10.5, 27.5] noise | 298 to 334 / 321 to 342 / 317 to 327 |
| docs CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| docs TBT | 5/5/5 | 66.0 (IQR 36.0, CV 33%) | 56.0 (IQR 8.00, CV 44%) | 29.0 (IQR 15.0, CV 31%) | -10.00 [-51.0, 43.0] noise | -27.0 [-80.0, 0.00] noise | -37.0 [-73.0, -5.00] | 47.0 to 102 / 39.0 to 109 / 25.0 to 49.0 |
| docs SpeedIndex | 5/5/5 | 367 (IQR 34.8, CV 10%) | 327 (IQR 3.39, CV 2%) | 337 (IQR 17.8, CV 4%) | -40.1 [-117, -24.8] | 10.7 [-4.67, 32.1] noise | -29.4 [-106, -8.01] | 353 to 443 / 321 to 342 / 324 to 359 |
| docs-deep LCP | 5/5/5 | 1,655 (IQR 31.3, CV 3%) | 1,545 (IQR 55.0, CV 7%) | 1,263 (IQR 37.1, CV 4%) | -109 [-264, 18.7] noise | -282 [-418, -127] | -392 [-511, -346] | 1,630 to 1,763 / 1,390 to 1,673 / 1,166 to 1,299 |
| docs-deep FCP | 5/5/5 | 342 (IQR 10.4, CV 6%) | 369 (IQR 2.71, CV 4%) | 368 (IQR 5.12, CV 1%) | 26.8 [-16.8, 60.2] noise | -0.48 [-33.9, 5.41] noise | 26.3 [-17.3, 29.8] noise | 338 to 386 / 363 to 402 / 363 to 369 |
| docs-deep CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| docs-deep TBT | 5/5/5 | 142 (IQR 16.0, CV 12%) | 117 (IQR 56.0, CV 37%) | 33.0 (IQR 5.00, CV 23%) | -25.0 [-96.0, 0.00] noise | -84.0 [-109, -24.0] | -109 [-139, -91.0] | 124 to 172 / 57.0 to 142 / 22.0 to 42.0 |
| docs-deep SpeedIndex | 5/5/5 | 412 (IQR 33.0, CV 19%) | 369 (IQR 2.71, CV 5%) | 373 (IQR 13.7, CV 3%) | -43.6 [-234, -0.79] | 3.90 [-39.0, 24.9] noise | -39.7 [-230, -17.0] | 390 to 602 / 363 to 412 / 363 to 394 |
| blog LCP | 5/5/5 | 1,173 (IQR 152, CV 10%) | 1,137 (IQR 16.7, CV 3%) | 1,051 (IQR 17.1, CV 5%) | -35.7 [-227, 59.2] noise | -86.5 [-138, 15.5] noise | -122 [-313, -20.2] | 1,087 to 1,364 / 1,087 to 1,189 / 1,021 to 1,153 |
| blog FCP | 5/5/5 | 279 (IQR 1.44, CV 6%) | 281 (IQR 7.69, CV 2%) | 278 (IQR 7.37, CV 2%) | 2.49 [-32.8, 9.35] noise | -3.45 [-9.45, 10.7] noise | -0.97 [-36.3, 7.04] noise | 272 to 314 / 272 to 287 / 272 to 285 |
| blog CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| blog TBT | 5/5/5 | 0.00 (IQR 0.00, CV 224%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [-10.0, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [-10.0, 0.00] noise | 0.00 to 10.0 / 0.00 to 0.00 / 0.00 to 0.00 |
| blog SpeedIndex | 5/5/5 | 452 (IQR 63.3, CV 9%) | 451 (IQR 19.4, CV 4%) | 342 (IQR 142, CV 28%) | -0.71 [-82.0, 24.4] noise | -109 [-179, 83.1] noise | -110 [-201, 82.4] noise | 442 to 533 / 435 to 476 / 272 to 534 |
| blog-post LCP | 5/5/5 | 275 (IQR 5.58, CV 4%) | 278 (IQR 1.36, CV 1%) | 281 (IQR 0.99, CV 4%) | 3.49 [-20.5, 7.49] noise | 2.88 [-1.13, 29.9] noise | 6.37 [-17.6, 33.4] noise | 274 to 298 / 276 to 282 / 278 to 308 |
| blog-post FCP | 5/5/5 | 275 (IQR 5.58, CV 4%) | 278 (IQR 1.36, CV 1%) | 281 (IQR 0.99, CV 4%) | 3.49 [-20.5, 7.49] noise | 2.88 [-1.13, 29.9] noise | 6.37 [-17.6, 33.4] noise | 274 to 298 / 276 to 282 / 278 to 308 |
| blog-post CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| blog-post TBT | 5/5/5 | 6.00 (IQR 1.00, CV 45%) | 0.00 (IQR 4.50, CV 137%) | 0.00 (IQR 18.5, CV 138%) | -6.00 [-12.5, -0.50] | 0.00 [-5.00, 21.5] noise | -6.00 [-12.5, 15.5] noise | 4.50 to 12.5 / 0.00 to 5.00 / 0.00 to 21.5 |
| blog-post SpeedIndex | 5/5/5 | 354 (IQR 11.8, CV 4%) | 278 (IQR 1.36, CV 1%) | 302 (IQR 23.9, CV 18%) | -76.1 [-94.8, -61.3] | 24.1 [2.88, 152] | -51.9 [-77.1, 75.5] noise | 339 to 373 / 276 to 282 / 281 to 430 |
| community LCP | 5/5/5 | 1,047 (IQR 10.4, CV 2%) | 282 (IQR 3.04, CV 1%) | 276 (IQR 2.93, CV 2%) | -765 [-793, -732] | -6.09 [-12.6, 2.32] noise | -771 [-799, -738] | 1,014 to 1,075 / 278 to 288 / 273 to 284 |
| community FCP | 5/5/5 | 276 (IQR 2.21, CV 1%) | 282 (IQR 3.04, CV 1%) | 276 (IQR 2.93, CV 2%) | 5.31 [0.99, 11.8] | -6.09 [-12.6, 2.32] noise | -0.78 [-4.57, 7.62] noise | 274 to 279 / 278 to 288 / 273 to 284 |
| community CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| community TBT | 5/5/5 | 0.00 (IQR 3.00, CV 170%) | 0.00 (IQR 0.00, CV 224%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [-11.0, 4.00] noise | 0.00 [-4.00, 0.00] noise | 0.00 [-11.0, 0.00] noise | 0.00 to 11.0 / 0.00 to 4.00 / 0.00 to 0.00 |
| community SpeedIndex | 5/5/5 | 392 (IQR 24.3, CV 4%) | 282 (IQR 3.04, CV 1%) | 320 (IQR 7.28, CV 2%) | -110 [-132, -95.5] | 38.2 [28.7, 46.5] | -71.6 [-94.7, -57.3] | 377 to 412 / 278 to 288 / 311 to 328 |
| profile LCP | 5/5/5 | 278 (IQR 13.9, CV 3%) | 281 (IQR 1.63, CV 1%) | 280 (IQR 10.1, CV 2%) | 2.93 [-3.37, 17.4] noise | -0.89 [-3.48, 12.5] noise | 2.04 [-1.18, 25.4] noise | 263 to 280 / 274 to 283 / 278 to 292 |
| profile FCP | 5/5/5 | 278 (IQR 13.9, CV 3%) | 281 (IQR 1.63, CV 1%) | 280 (IQR 10.1, CV 2%) | 2.93 [-3.37, 17.4] noise | -0.89 [-3.48, 12.5] noise | 2.04 [-1.18, 25.4] noise | 263 to 280 / 274 to 283 / 278 to 292 |
| profile CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| profile TBT | 5/5/5 | 0.00 (IQR 0.00, CV 224%) | 0.00 (IQR 2.00, CV 138%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [-2.50, 2.50] noise | 0.00 [-2.50, 0.00] noise | 0.00 [-2.50, 0.00] noise | 0.00 to 2.50 / 0.00 to 2.50 / 0.00 to 0.00 |
| profile SpeedIndex | 5/5/5 | 406 (IQR 30.7, CV 4%) | 281 (IQR 1.63, CV 1%) | 317 (IQR 39.0, CV 10%) | -125 [-132, -93.9] | 36.2 [12.0, 94.1] | -89.0 [-115, -31.1] | 375 to 411 / 274 to 283 / 293 to 375 |
| community-package LCP | 5/5/5 | 279 (IQR 11.3, CV 3%) | 322 (IQR 3.22, CV 1%) | 317 (IQR 2.41, CV 1%) | 42.4 [28.8, 46.3] | -4.43 [-7.52, -0.093] | 38.0 [24.3, 42.7] | 276 to 293 / 319 to 325 / 315 to 322 |
| community-package FCP | 5/5/5 | 279 (IQR 11.3, CV 3%) | 322 (IQR 3.22, CV 1%) | 317 (IQR 2.41, CV 1%) | 42.4 [28.8, 46.3] | -4.43 [-7.52, -0.093] | 38.0 [24.3, 42.7] | 276 to 293 / 319 to 325 / 315 to 322 |
| community-package CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| community-package TBT | 5/5/5 | 2.00 (IQR 6.00, CV 113%) | 4.00 (IQR 2.50, CV 102%) | 0.00 (IQR 0.00, CV 224%) | 2.00 [-7.50, 11.5] noise | -4.00 [-13.5, 0.00] noise | -2.00 [-11.5, 0.000] noise | 0.50 to 11.5 / 0.00 to 13.5 / 0.00 to 2.00 |
| community-package SpeedIndex | 5/5/5 | 404 (IQR 55.9, CV 8%) | 322 (IQR 2.02, CV 1%) | 360 (IQR 26.5, CV 8%) | -81.5 [-120, -53.1] | 38.2 [13.6, 85.1] | -43.3 [-97.2, 3.62] noise | 375 to 442 / 319 to 325 / 336 to 407 |
| account LCP | 5/5/5 | 276 (IQR 8.35, CV 2%) | 321 (IQR 2.01, CV 1%) | 320 (IQR 0.62, CV 1%) | 44.7 [33.7, 52.2] | -0.73 [-8.26, 1.43] noise | 43.9 [32.9, 49.5] | 271 to 287 / 319 to 329 / 316 to 322 |
| account FCP | 5/5/5 | 276 (IQR 8.35, CV 2%) | 321 (IQR 2.01, CV 1%) | 320 (IQR 0.62, CV 1%) | 44.7 [33.7, 52.2] | -0.73 [-8.26, 1.43] noise | 43.9 [32.9, 49.5] | 271 to 287 / 319 to 329 / 316 to 322 |
| account CLS | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.00] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.00 |
| account TBT | 5/5/5 | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 0%) | 0.00 (IQR 0.00, CV 224%) | 0.00 [0.00, 0.00] noise | 0.00 [0.00, 0.50] noise | 0.00 [0.00, 0.50] noise | 0.00 to 0.00 / 0.00 to 0.00 / 0.00 to 0.50 |
| account SpeedIndex | 5/5/5 | 544 (IQR 22.0, CV 6%) | 321 (IQR 2.01, CV 1%) | 352 (IQR 27.7, CV 10%) | -223 [-264, -184] | 31.1 [9.55, 95.5] | -192 [-233, -128] | 505 to 585 / 319 to 329 / 332 to 417 |


## Attribution

C is B with only the Redact Vite integration removed, so:

- **A to C** is the change in framework, router and data layer (Remix 3 to TanStack Start, Router, Query and Emotion), with React kept.
- **C to B** is the change from React and React DOM 19.3.0 to Redact 0.1.4. Everything else is held constant.

All numbers below are medians from the tables further down. "noise" means the 95% CI of the median difference includes zero.

| Metric | A to C (framework, keeping React) | C to B (React to Redact) |
|---|---|---|
| Whole-build client JS gzip | +346,703 bytes | -47,984 bytes |
| Source maps, React vs Redact (raw generated bytes) | React 219,013 in C | Redact 62,726 in B |
| JS gzip on cold `/` | +123,675 bytes | -46,437 bytes |
| JS gzip on cold `/account` | -47,299 bytes | -46,680 bytes |
| Origin worker entry gzip | -793,826 bytes | 0 bytes (the B and C entries are the same size, 595,779 raw) |
| Origin startup CPU | -66.8 ms (-97.1 to -61.0) | +0.8 ms, noise (-3.1 to 3.9) |
| Warm TTFB `/` | -24.2 ms (-25.4 to -23.1) | -3.3 ms (B is faster than C by 2.7 to 4.3) |
| Warm TTFB `/account` | -29.8 ms (-32.3 to -25.7) | +0.3 ms, noise |
| Navigation, all steps pooled, CPU 1x, no hover | -8 ms, noise (-37.5 to 18) | +33.5 ms (3.0 to 65) |
| Navigation, all steps pooled, CPU 4x, no hover | +16 ms, noise (-41 to 90.5) | +182.5 ms (110.5 to 243) |
| Hydration main thread `/`, CPU 1x | -17.9 ms (-26.1 to -4.3) | -31.8 ms (-42.0 to -20.5) |
| Hydration main thread `/account`, CPU 1x | +15.2 ms (5.5 to 25.0) | +0.8 ms, noise |
| Hydration main thread `/account`, CPU 4x | +246.5 ms (207.0 to 269.7) | +72.4 ms (37.2 to 126.0) |
| Hydration main thread `/docs`, CPU 4x | -124.6 ms (-179.5 to -84.9) | +168.4 ms (110.5 to 223.4) |

C to B is the negative of the "B to C" column in the full tables. Startup CPU at B and C has n=10 successful samples, and the timeouts are listed under Failures.

Bytes and time are attributed differently:

- **Bytes:** the source-map breakdown (table 1b) separates Redact, React, the TanStack packages, Emotion, app code and other dependencies directly. In B's entry closure, Redact is 62,726 raw bytes, TanStack Router 83,473, Query 36,345, Start 10,169 and Emotion 15,494. In C, React and React DOM are 219,013 raw bytes in the same closure. At A, Remix is 126,265 raw bytes of the entry closure and 152,971 of the whole build. App code is 439,259 at A and 379,419 at B.
- **Main-thread time:** this was not split by module. The trace sums task, script-evaluation and long-task time up to the hydration marker, and the C to B difference is the closest available estimate of what Redact changes. It covers both Redact's own execution and any effect Redact has on how the same app code runs, and the two cannot be separated with these measurements.

Changes in architecture that are not framework speed, and that show up in the numbers:

- **Server functions and TanStack Query replace the backend router's loaders.** A client navigation at B or C makes a median of 5 requests and transfers 5.4 to 6.0 KB. At A it makes 2 requests and transfers 1.7 to 1.8 KB (table 4, all conditions). A 300 ms hover lowers the median on every variant (CPU 1x: A 133 to 85 ms, B 158.5 to 124, C 125 to 96), but which requests are prefetched, and whether Query serves later visits from its cache, was not traced. These navigation timings therefore include different data-fetching strategies, not only router and renderer cost.
- **Nested layouts keep the parent rendered.** At B and C the workspace shell stays mounted during in-workspace navigation. The detector found no loading frames on any B or C navigation. A shows one loading frame or empty `main` on every repetition of two steps: the email filter change and the org members to teams tab change (80 of 560 navigations per condition, so a median of 0 and a mean of 0.14 flashes per navigation). The other 12 steps at A showed none.
- **Worker split:** at B the origin worker entry is 595,779 bytes raw, spread over 1,268 server JS files that total 27.8 MB. A's entry is 3,931,760 bytes over 256 files totaling 26.0 MB. This explains most of the difference in worker gzip and startup CPU, and it is a code-splitting choice of the new build, separate from per-request render speed.
- **Server-Timing** is emitted only at A, so server-side phases cannot be compared.

## Route and feature parity

The route authority is `packages/worker/universal/routes.ts` at A (193 page patterns, `.json` endpoints excluded) and the file routes in `packages/worker/start/routes` at B (251 routes, `__root` excluded). `harness/route-diff.py` lists the patterns that appear on only one side. `harness/route-parity-probe.mjs` then sent a signed-in `GET` to each of them on both A and B, without following redirects (`results/routes/route-parity-{a,b}.json`).

- **All 18 benchmark routes** return 200 on A, B and C with the same fixture data. A and B use the same canonical paths, so no route had to be mapped differently.
- **Only on B: 37 legacy `/account/*` aliases** (`/account/jobs`, `/account/email`, `/account/memories`, `/account/secrets`, `/account/workflows` and similar). B answers each with a 302 to `/@user-me/-/...`, and A returns 404. `/account/billing/success` returns 404 on A and 405 to `GET` on B.
- **Only on A: `GET /webauthn/authentication` and `GET /webauthn/registration`** return 200 on A and 404 on B.
- **`/@user-me/-/billing/portal`** returns 302 on A and 404 on B.
- **A-only POST endpoints:** `/logout`, `/password-reset`, `/password-reset/confirm`, `/account/delete`, `/join/:token/decline`, `/docs/mcp-events/opt-in` and `/docs/package-skills/opt-in` answer `GET` with 405 on A, which means a POST handler exists there. They return 404 to `GET` on B. POST was not probed, because it would mutate state (for example `/account/delete`). B may serve these through server functions or other paths, so their absence on B is not confirmed.
- **Same on both:** the `.well-known` JSON files, `/oauth/authorize` and `/oauth/callback` return 200 on both sides, and `/guides/*` returns 308 to `/docs/*` on both. The route-diff listed these only because of naming differences.
- **Avatar routes:** `/orgs/:orgSlug/avatar/*` and `/profiles/:username/avatar/*` return 404 on both sides with placeholder file names, so the probe cannot tell whether the routes exist.
- **Not checked:** product features that do not show up as routes, for example individual controls on a page.

## Caveats

- **Local runtime:** this is local workerd through `wrangler dev` on the built output, not Cloudflare's edge. Nothing was throttled at the network level, so TTFB and navigation times have no real network latency, only loopback.
- **Small data:** about 12 jobs, 10 emails, 15 memories, 12 credentials, one org and one community listing. List pages are short, and render and data costs at production sizes were not measured.
- **Lighthouse is lab data:** it ran on localhost with simulated throttling (the preset defaults), so it is not field data. web-vitals INP comes from scripted clicks, not real users.
- **Worker startup is not reliable on this machine.** `wrangler check startup` timed out after 10 s for 6 B attempts and 12 C attempts, and for none at A. The timeouts are kept as failures in `results/worker/startup-samples-*.json`, and the harness retried until it had 5 successful samples per pass. Successful samples have CV 13 to 20%, and n stayed at 10, because each extra pass would have needed a full rebuild. The check profiles only the evaluation of the origin entry module. At B the entry is 595,779 bytes raw out of 27.8 MB of server JS. At A the entry is 3,931,760 bytes. Startup CPU therefore covers different shares of the code on each side.
- **Flaky local server:** the first app requests right after a server start sometimes failed with "Network connection lost", even though `/health` was already 200. Each variant round waits until login and route resolution succeed (`ready.mjs`, with failed attempts logged in `results/run-log.txt`). One A cold-start restart hung. That run is kept as `results/coldstart/coldstart-a-r1-contaminated.json.raw` and was replaced by a rerun of A round 1 cold starts after all other rounds. The replacement is therefore outside the alternating order.
- **Order deviation:** in round 1, an orphaned navigation process from an aborted earlier attempt overlapped the first 20 s of A's round (readiness, parity and warmup) and at most about 1 s of A's first TTFB batch.
- **Navigation adaptations:** `/account` has no direct link to jobs on either side, so the jobs sequence is account, then overview, then jobs list, then job 1, then job 2, then Back twice. The email filter step has a weaker readiness signal (see Method). Credential detail IDs differ per variant because each side seeded its own random IDs. The keys are normalized to `credentials/detail`.
- **C is not a shipped configuration:** it skips B's Redact verifier and changes only `vite.config.ts`. React 19.3.0 is the version already in B's lockfile.
- **Generated file:** builds at B and C rewrite `packages/worker/start/routeTree.gen.ts` (type-only registration lines). The local worker-startup run count was raised from 3 to 5 in each worktree's `tools/worker-startup-budget.json` and then restored. These are worktree-local changes and are not part of any commit.
- **Server-Timing:** only A emits the header (`session`, `youtubeWatch` and `ssr` durations). B and C send none, so no server-side breakdown can be compared.

## Failures, exclusions and what was not measured

- **Worker startup timeouts:** 18 timeouts of `wrangler check startup` at 10 s, all on the origin worker (A 0, B 6, C 12). Every one is kept in `results/worker/` and listed in `results/summary.json` under `failures`. The medians use only successful samples, 10 per target per variant.
- **Readiness retries:** 12 variant-round starts needed a total of 6 failed login or route-resolution attempts before they became ready (`results/run-log.txt`). Nothing was measured during those attempts.
- **Contaminated cold-start run:** A round 1 cold starts hung on one restart, because of a server.sh bug that was fixed later. The file is kept as `results/coldstart/coldstart-a-r1-contaminated.json.raw` and is not in the statistics. A round 1 was rerun after round 2, with 0 failures, so every variant has n=20 cold starts.
- **Assets and Lighthouse in rounds 3 and 4:** skipped by design (`SKIP_ASSETS`, `SKIP_LH`). Asset bytes were identical in every run (CV 0%). Lighthouse has n=5 per configuration.
- **High CV:** 824 of 2,193 metric-variant cells have a CV above 10%. These are mostly web-vitals, per-route TTFB, hydration, navigation and Lighthouse timings. n for these was raised from 2 rounds to 4 (TTFB 100, hydration 40 at 1x and 20 at 4x, navigation 40 per step per condition, cold start 20). n was not raised further. Pooled "all steps" navigation rows mix 14 different steps, so their CV mostly reflects the differences between steps. Use the per-step tables (4b, 4c) for step-level variation.
- **Not measured:** per-module main-thread attribution inside Redact or React (see Attribution), POST-only routes, real network latency, field data, production-sized data, and `/mcp` and the other flows that need remote services locally (Vectorize, Artifacts, package publish).
- **Redacted session cookie:** in the pushed copy only, the local test session cookie inside the 30 `/account` Lighthouse JSON files is replaced with `kody_session=REDACTED`. Nothing else in those files changed.
