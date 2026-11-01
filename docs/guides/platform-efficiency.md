---
id: platform_efficiency
title: Runtime and efficiency
summary:
  How unique Dynamic Worker days work across execute, jobs, package exports, and
  other surfaces, and how the acting user plus a stable module graph reuse one
  isolate per UTC day.
category: platform
---

# Runtime and efficiency

Everything your agent runs in Kody — an ad hoc `execute`, a package export, a
job, a workflow step, a package app request — runs server-side in a Cloudflare
Dynamic Worker isolate, not on your laptop and not inside a chat model. Kody
meters unique Dynamic Worker days so that isolate cost is visible by surface.
This page states that cost model once. Package README and AGENTS.md files do not
repeat it.

## Unique worker days

Cloudflare bills **unique Dynamic Worker isolates** (a worker id) **per UTC
day**. Kody records that unit as the `unique_worker_days` / `dynamic_worker_day`
meter.

- The first use of a given worker id on a UTC day counts once for that user.
- Repeating the same worker id on the same UTC day does not add another day.
- The billed worker follows only what you control: the acting user, storage
  context, your code, and your own modules (saved and published package source,
  so a republish is a new worker). The same user and code count once per UTC
  day; different code or a different user is a different worker.
- Kody deploys do not start a new billed worker. A deploy that changes Kody's
  executor or runtime can load a fresh isolate, but unchanged code that already
  ran today does not count again.
- Runs on an [execution context](./execution-contexts.md) (your own machine) do
  not count: they run in workerd there, not in a Kody cloud isolate. A run that
  falls back to Kody cloud counts like any cloud run.
- Every `execute` response says what that call charged in `ranOn.workerUnits`
  and its "Ran on …" line (`Ran on nautilus (your machine), 0 worker units.`).

Workspace usage (`/@<slug>/-/usage` and `usageGet`) shows this meter as **Worker
compute**, next to **Rows read** and the execute caps. The $12 Pro plan includes
a monthly amount of both. Past the include, usage is charged from prepaid
credits until they run out, and then usage past the include stops. Free, and Pro
accounts without prepaid credits (retired plans or gifted months), keep their
daily and weekly caps instead — see [Pricing](https://kody.codes/pricing).
Nobody is invoiced for overage.

On Free, Worker compute past the include is informational: it never charges the
account or stops runs, and Kody does not email about it. Execute caps are the
Free limit. Do not spend execute calls diagnosing a high Worker compute count on
Free; move repeated ad hoc work into packages or triggers instead.

When a hosted `execute` call starts a new worker and the workspace has used 80%
or more of its included Worker compute this month, that response carries a
one-time usage heads-up in `warnings` (and its text), once per workspace per UTC
month. It goes with the 80% and 100% warning emails rather than replacing them;
Free and other plans without a credit wallet do not get it.

### Usage warnings

The 80% and 100% usage emails and the execute heads-up are on by default. An
Owner can turn all of them off for an org (personal or team) in **Organization
settings**, **Usage warnings**, with `orgUpdate` (`PATCH /v1/orgs`), or from the
CLI:

```sh
kody api orgUpdate --params '{"usage_warnings":false}'
```

Turning them off stops only the warnings. Limits, credits, and the usage page
(`usageByPackageGet`) are unchanged, and Kody admins still see the crossings.

To see what starts the most workers, open **Where it went** on the usage page or
call `usageByPackageGet`. Packages are ranked by credits. The Ad hoc row also
lists which connection (MCP agent, Kody CLI, API token, Automation) started the
most Ad hoc workers (`adHocConnections`). That list counts Worker compute units
(inside and past the include) for at most the last 14 days of the month.

## Rows read

Storage SQL that examines a lot of rows is allowed. Those rows count toward the
monthly **Rows read** include, and usage past the include is billed from
credits, same as Worker compute. `warning` on the SQL result is set once a
statement examines at least 1,000,000 rows. One read stops after 1,000,000,000
rows examined. Narrow with `LIMIT` or `WHERE`. The separate 1,000-row return cap
only limits how many rows come back in one response.

## Surfaces

The same meter is tagged with the surface that minted the isolate:

| Surface                      | Typical mint                                |
| ---------------------------- | ------------------------------------------- |
| `execute`                    | Ad hoc MCP / capability `execute`           |
| `job`                        | Package-owned scheduled or `jobRunNow` work |
| `package_export`             | A saved-package export invocation           |
| `workflow`                   | A Cloudflare Workflow run                   |
| `subscription`               | A package subscription handler              |
| `app_fetch` / `app_realtime` | A package app HTTP or websocket isolate     |
| `webhook`                    | Authenticated inbound webhook delivery      |

Saved packages, jobs, and other durable surfaces reuse a stable isolate when the
published module graph stays the same. Ad hoc `execute` identity follows the
acting user plus the module graph of that execute run. Varying `params` and
`packageContext` reuse that isolate — put args in `params`, not literals in
`code`:

```ts
import { kody } from 'kody:runtime'

// Bad: each distinct literal is another isolate
export default async function main() {
	return await kody.emailSend({ subject: 'Hello', text: 'Hi' })
}

// Good: same graph, vary via params
export default async function main(params) {
	return await kody.emailSend(params)
}
// execute({ code, params: { subject: 'Hello', text: 'Hi' } })
```

## Choosing a surface

Search first, then pick the smallest durable home that matches the work:

- A built-in capability or an existing saved-package export, called from
  `execute` or another package.
- A saved package when the behavior will be reused, scheduled, tested, or
  evolved — see [Package lifecycle](./package-lifecycle.md) and
  [Package authoring](./package-authoring.md).
- A [workflow](../use/workflows.md) for durable multi-step or deferred work.

`execute` is the exploration and composition surface. Durable named behavior
lives in a package so later runs share that package's module graph.

## Related

- [Jobs, workflows, and webhooks](./triggers.md) — which surface starts a run
- [Execute and workflows](../use/execute.md)
- [Plans and pricing](https://kody.codes/pricing)
- Contributor metering schema:
  [Usage metering](../contributing/architecture/usage-metering.md)
