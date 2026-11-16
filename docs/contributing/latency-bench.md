# MCP latency bench

`tools/latency-bench/run.ts` measures the latency Kody adds on top of the
underlying call for the hosted MCP paths. It is the number to compare with
per-call MCP gateways: Kody round trip minus the same call made directly.

```bash
npm run latency-bench -- --origin http://localhost:3742 --n 30
npm run latency-bench -- --origin <preview> --email me@kentcdodds.com --password ilikecode \
  --fetch-url https://example.com/ --secret-name benchToken \
  --mcp-server bench --mcp-tool ping --mcp-direct-url https://bench-mcp.example/mcp \
  --package-import kody:@user-me/bench-pkg --json --out latency-bench.json
```

Paths (each records one cold sample, then `--n` warm samples, p50/p95/p99):

| path                     | what it measures                                                                |
| ------------------------ | ------------------------------------------------------------------------------- |
| `health`                 | origin round trip with no auth (network floor)                                  |
| `mcp-tools-list`         | OAuth token check + stateless lane + tool registration, no tool handler         |
| `execute-noop`           | `export default async () => 1`: pure platform overhead incl. dynamic worker     |
| `execute-fetch-plain`    | one `fetch` through the sandbox fetch gateway (needs `--fetch-url`)             |
| `execute-fetch-secret`   | same fetch with a `{{secret:NAME}}` header (needs `--secret-name`)              |
| `execute-mcp-tool`       | `kody.mcp[server].tool(args)` through the MCP client hub (needs `--mcp-server`) |
| `execute-package-export` | import and call a saved package export (needs `--package-import`)               |
| `search`                 | the `search` tool                                                               |
| `direct-fetch`           | the `--fetch-url` fetched directly from the bench process                       |
| `direct-mcp-tool`        | the `--mcp-direct-url` tool called directly over a persistent MCP client        |

`--concurrency <k>` runs the warm samples in batches of `k` concurrent calls,
which is how an isolate memory limit shows up. Failed samples are counted per
error message in `failures`, so a report gives an out-of-memory rate directly:

```bash
npm run latency-bench -- --origin https://kody.codes --token <test-account-token> \
  --paths execute-package-export --package-import kody:@org-test/big-pkg/drive \
  --n 12 --concurrency 3 --json --out big-import.json
```

Execute paths also report the server-side `timing.durationMs` (tool handler
only) and the `serverTiming` phases execute returns (`bundle`, `hydrate`,
`provider-assembly`, `sandbox`, `run`). `wall − tool` is therefore the auth,
account write lease, lane, and serialization cost that no client can see today.
The `added over direct` table subtracts the direct baseline from the matching
Kody path.

Rules:

- Never point `--secret-name` at a real credential. Create a throwaway secret
  whose value is not sensitive and whose `allowedHosts` match `--fetch-url`.
- `https://kody.codes` requires `--token` (a dedicated test account); the bench
  refuses to log in there with a password.
- `--package-import` needs the remote `ARTIFACTS` binding, so saved-package
  numbers come from a PR preview or a test account, not `npm run dev`.

[`.github/workflows/latency-bench.yml`](../../.github/workflows/latency-bench.yml)
runs the bench weekly (and on `workflow_dispatch` with an `origin` input)
against `LATENCY_BENCH_ORIGIN` using `LATENCY_BENCH_TOKEN`, uploads the JSON
report as an artifact, and writes the markdown table to the job summary so
regressions are visible run over run. When those secrets are not configured the
job skips instead of failing.
