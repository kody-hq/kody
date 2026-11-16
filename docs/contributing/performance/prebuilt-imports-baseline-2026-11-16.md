# Hosted execute with `kody:@` imports: baseline, November 16, 2026

Hosted ad hoc execute runs esbuild over every published artifact it imports,
inside a throwaway `RepoSession` Durable Object
(`packages/worker/src/package-runtime/isolated-execute-bundle.ts`). This report
records what that costs today, before hosted execute switches to loading
published artifacts as prebuilt modules, and the Worker Loader limits that
switch depends on.

## Fixtures

All fixtures lived in a temporary team org and were deleted afterwards.

- `perf-shared`: one export, about 178 KB built.
- `perf-mid-1` to `perf-mid-6`: about 250 KB each, each importing `perf-shared`.
- `perf-hub/drive`: about 4 MB of its own code plus the six mid packages,
  published with `--build local` (CLI 3.36.1). The published `importable-module`
  artifact in `BUNDLE_ARTIFACTS_KV` is about 4.9 MB.

Each case ran 12 hosted executes of
`import run from "kody:@<org>/<package>"; export default async () => run({})`
against `https://kody.codes` on November 16, 2026 (small at 03:13 UTC on
`809a0757`, large at 04:57 UTC on `0f3faefb`): three batches of three concurrent
calls, then three sequential calls. CPU, wall time, and outcome come from
Workers Observability for `RepoSession` `buildIsolatedExecuteBundle`. There is
no per-request memory metric; `exceededMemory` is the closest one.

## Results

| case                     | succeeded | bundle isolate CPU | bundle isolate wall | request wall |
| ------------------------ | --------- | ------------------ | ------------------- | ------------ |
| small (`perf-shared`)    | 12 of 12  | 0.3 to 3.4 s       | 0.8 to 4.9 s        | 2.5 to 4.8 s |
| large (`perf-hub/drive`) | 0 of 12   | 1.9 to 5.8 s       | 2.4 to 6.7 s        | 3.9 to 9.4 s |

Every large run ended with `exceededMemory` in the bundle isolate and the "too
large to bundle on Kody cloud" error. The API isolate (`KodyApi /v1/execute`)
used 18 to 380 ms of CPU per request in both cases.

## Worker Loader limits

Cloudflare documents no per-module count or size limit for Worker Loader beyond
the 64 MiB Worker size. Measured by publishing padded artifacts with
`--build local` and running them through `jobRunNow`, which passes the published
`artifact.modules` to the loader unchanged:

| artifact         | publish  | run                 |
| ---------------- | -------- | ------------------- |
| 1,001 modules    | accepted | succeeded, 1,082 ms |
| one 10 MB module | accepted | succeeded, 4,814 ms |
| one 20 MB module | rejected | not run             |
| one 30 MB module | rejected | not run             |

The 20 MB and 30 MB modules were refused by publish verification ("does not
parse as a module"), not by the loader. So every artifact that publish accepts
is within what the loader takes, and a hosted execute that attaches several such
artifacts stays inside the 64 MiB Worker limit only while their total stays
under it.

## Reproducing

`tools/latency-bench/run.ts` covers the request side:

```bash
npm run latency-bench -- --origin https://kody.codes --token <test-account-token> \
  --paths execute-package-export --package-import @org-test/big-pkg/drive \
  --n 12 --concurrency 3 --json --out big-import.json
```

Bundle cache hits and misses are logged as `module_bundle_cache` events with
`outcome`, `bundleContext`, and `moduleCount`.
