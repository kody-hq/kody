---
name: app-perf
description: >
  Measure web app performance before and after a change: binding round trips and
  sequential depth per page, requests on hover and click, and bundle gzip sizes.
  Use when a page or navigation is slow, when changing loaders, server
  functions, request-scoped reads, page queries, or shared client imports, or
  when a PR claims a performance win.
---

# app-perf

Do not time pages with a stopwatch or write a one-off script. Local wall-clock
time hides the production cost, which is sequential round trips. Use
`npm run app-perf` and read
[Web app performance](../../../docs/contributing/app-performance.md).

1. Start the dev server with
   `VITE_KODY_PERF_PROBE=1 npm run control-kody -- dev` and sign in with
   `npm run control-kody -- login --email <you>`.
2. Before the change:
   `npm run app-perf -- ssr --org <slug> --package <org>/<name> --out before.json`.
3. Find the cause with `--trace <route>`: it names the function behind each
   round trip. Lower `depth` first, then `repeats`, then `d1`.
4. Fix the shared primitive when the same caller shows up on many routes
   (request-scoped memo, a batch, a page query), not each route.
5. After the change, write `after.json` and run
   `npm run app-perf -- compare before.json after.json`. Paste the table into
   the PR.
6. For navigation changes run `npm run app-perf -- nav <path> <path> ...`. For
   import changes run `npm run build` then `npm run app-perf -- bundle <chunk>`.

Production is read-only: sample `Server-Timing` with `curl`, never write data to
measure.
