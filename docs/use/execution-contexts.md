# Execution contexts

Run `execute` and automations on your own machine instead of Kody cloud. Usage,
setup, and behavior live in the
[Execution contexts guide](../guides/execution-contexts.md)
(`search({ entity: "guide:execution_contexts" })`).

Execution contexts are an experiment. Turn them on at
[`/account/experiments`](https://kody.codes/account/experiments) or with
`experimentSet({ experiment: "execution-contexts", enabled: true })`.

## Fields

- `execute` takes `context` (id or name), `fallback: "chain"`, `chain` (up to 3
  contexts, `"cloud"` only last), and `requires: ["fs" | "lan"]`. See
  [Execute and workflows](./execute.md#execution-contexts).
- Results carry `ranOn`: `{ kind, id, name, attempts, fellBackToCloud }`.
  `attempts[]` is `{ target, name?, outcome, reason? }` for each skipped entry
  (`offline`, `busy`, `rejected`, …).
- Automations take `execution` with the same shape plus
  `whenOffline: "fail" | "queue"` and `queueMinutes` (default 60, max 1440).
  Read and set overrides with `automationExecutionGet` /
  `automationExecutionSet`.
- Capabilities: `executionContextList`, `executionContextGet`,
  `executionContextUpdate`, `executionContextRevoke`, `executionContextDelete`,
  `executionContextRunList`, `executionChainGet`, `executionChainSet`, and the
  sharing capabilities. Find them with `search({ query: "execution context" })`.
- CLI: `kody connect --name <name>` (register plus background service),
  `kody context register --name <name>`,
  `kody daemon install | status [--json] | logs | restart | uninstall`,
  `kody update`, `kody context policy allow <path> [--mode ro|rw]`,
  `kody daemon [--max-concurrent <n>]` (`KODY_CONTEXT_MAX_CONCURRENT`, 1 to 8,
  default 2), `kody chain show | add | remove`.
