# 0085: Execute takes code only

- **Status:** accepted
- **Date:** 2026-10-28

## Context

The `execute-invoke` experiment let MCP `execute` and Open API `/v1/execute`
take `invoke: "kody:@scope/package/export"` instead of `code`. The server wrote
the same thin passthrough module an agent would write and ran it. Usage moved to
it quickly (a large share of one maintainer's executes and one heavy external
user's), but it was a second way to say the same thing: one more schema field,
one more description branch, a feature flag, a mutual-exclusion rule, a strict
credential mode that only applied to it, and a second run-record attribution.

## Decision

Kody will not take a module reference on hosted execute. `code` is the only
module field. Calling one export is a two-line passthrough:

```ts
import action from 'kody:@scope/package/export'
export default (params) => action(params)
```

The flag and its gate sites are deleted. A call that still sends `invoke` gets
an error showing that `code` for its specifier instead of being ignored. The CLI
keeps `kody execute --invoke` as client-side sugar: it writes the passthrough
and sends `code`, so it costs nothing on the server.

## Consequences

Agents write one extra line per single-export call. Run records written while
the shortcut existed keep `entry: invoke` and stay readable; new runs record
`entry: code`. The migration error stays at least 30 days (until 2026-11-27 at
the earliest) and is then removed, after which `invoke` is just an unknown
argument. Revisit only if a module-reference field earns its own primitive (for
example a cacheable reference with different billing), not as an alias for
`code`.
