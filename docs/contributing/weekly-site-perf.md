# Weekly site performance

Production landing performance is measured every Monday (UTC) against
https://kody.codes/. The collector only answers one question: did something
cross a budget or fail a landing signal?

| Verdict     | What happens                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`        | Budgets hold. Existing "Weekly site perf" issues close. No package invoke.                                                                                                                                 |
| `needs-fix` | A tracking issue stays open and the workflow invokes Kent's `weekly-site-perf` Kody package. That package launches a Cursor cloud agent. The agent decides whether to implement a fix or stop for a human. |

The GitHub Action never edits the site and never classifies "human vs
implementable." It measures, upserts the issue, and (when a fix is needed) calls
Kody.

## Measure

```bash
npm run site-perf -- --url https://kody.codes/ --json
```

[`tools/site-perf/collect.ts`](../../tools/site-perf/collect.ts) fetches the
homepage, records HTML weight, `Cache-Control`, the largest same-origin JS
payload, the preloaded LCP image, TTFB, and `Server-Timing` phases (`session`,
`ssr`, plus loader phases such as `listings`). When the primary URL is `/`, it
also probes `/onboarding` and `/docs/how-kody-works` for the same timing
snapshot. Those extra pages are observational and do not change the verdict. A
failed extra probe is omitted so homepage classify still runs. Homepage HTML
that lacks an app `ssr` phase is a finding. A `syntax-highlight` modulepreload
on `/` is a finding (TanStack Highlight belongs on guides and onboarding, not
the landing entry). The collector then classifies against
[`tools/site-perf/budget.json`](../../tools/site-perf/budget.json).

It also runs the hello-world package app `@kentcdodds/perf-hello` (package id
`87aebd1f-9589-4c5a-b34e-40f191413564`, whose `fetch` returns `ok`) three times
back to back through Open API `packageAppFetch`
(`POST https://api.kody.codes/v1/packages/app-fetch`) and records
`packageApp.samples` (status, API round trip as `ttfbMs`, and the app's
`Server-Timing` serve phases such as `manifest`, `usageGate`, `appLoader`, and
`entrypoint`). The first sample may be cold; later ones show the warm path. The
serve phases are Kody's platform overhead on package-app requests (budget: tens
of ms, see
[invocation overhead guardrails](./architecture/invocation-overhead-guardrails.md)).
The call authenticates with `KODY_API_TOKEN`, so the app does not need to be
internet-visible. It measures the signed-in serve path; the hosted-host phases
(`appSession`, `appTicket`, `retiredSlug`) are not in it. The probe is
observational and never changes the verdict. Without a token it is skipped; a
rejected token or failed sample is recorded in `packageApp.error`.
`--package-app-id <id>` points it at another app and `--no-package-app` skips
it. Keep `@kentcdodds/perf-hello` a pure hello world.

The workflow reads the token from the repository secret
`KODY_SITE_PERF_API_TOKEN`. Mint it with `tokenCreate` (scopes
`["app:execute", "package:read"]`, `idle_ttl_seconds: 1209600`,
`max_lifetime_seconds: 7776000`; 90 days is the maximum), then set the GitHub
secret. Rotate it with `tokenRotate` before it expires; an expired token shows
up as a `packageAppFetch HTTP 401` in `packageApp.error`.

[`.github/workflows/weekly-site-perf.yml`](../../.github/workflows/weekly-site-perf.yml)
runs that collector on Mondays at 14:17 UTC and on `workflow_dispatch`.
`needs-fix` upserts `Weekly site perf: needs a fix`. A later `ok` run closes
that issue (and the older `actionable` / `human review` titles).

## Kody package invoke

When the verdict is `needs-fix` and `KODY_WEBHOOK_URL_RUN` is set, the same job
`POST`s that minted webhook URL with a params-mode JSON body and an
`Idempotency-Key` header. There is no `Authorization` header; the URL is the
credential. See [inbound webhooks](../use/webhooks.md).

The `weekly-site-perf` package owns the agent prompt and calls `createAgent`
from `@kentcdodds/cursor`. The Cursor API key stays a Kody secret on that Cursor
package. The agent implements an obvious local fix when it can, follows
[`.agents/skills/ship-pr/SKILL.md`](../../.agents/skills/ship-pr/SKILL.md), or
leaves the tracking issue open when a human should decide.

`@kentcdodds/weekly-site-perf` declares webhook `run` (`inputMode: "params"`,
`responseMode: "sync"`) on the root `.` export. The live Action reads the minted
URL from the repository (or org) secret `KODY_WEBHOOK_URL_RUN`. Kent copies that
value from the Kody user secret `weeklySitePerfWebhookRun` at
https://kody.codes/@<slug>/-/secrets/user/weeklySitePerfWebhookRun. Agents never
paste the URL. Rotate with `webhookUrlRotate`, then update both the Kody user
secret and the GitHub secret. See [setup manifest](./setup-manifest.md).

If the secret is unset, blank, or not a valid `http(s)` URL, the workflow still
measures and upserts the issue. It skips the invoke so the weekly job stays
green.

Retries of the same GitHub run reuse
`Idempotency-Key: weekly-site-perf:<GITHUB_RUN_ID>` (and the same
`idempotencyKey` in the JSON body). A successful sync invoke that returns an
agent URL comments it on the open needs-fix issue. `409 invocation_in_progress`
counts as launched; `409 idempotency_mismatch` and other non-2xx responses fail
the step.

## What the homepage already does

Anonymous `/`, `/pricing`, `/blog`, `/community`, `/onboarding`, `/docs`, and
`/docs/:slug` HTML is `public, max-age=60, stale-while-revalidate=300` with
`Vary: Cookie`. Doc markdown (`/docs/:slug.md`) is the retained machine-readable
twin. Any `kody_session` cookie, a resolved session, or a `Set-Cookie` response
stays `no-store` on HTML. Auth, OAuth, and account pages never use the short CDN
cache.

Landing layout CSS lives in `packages/worker/public/styles.css` (`.landing-*`).
Hero and below-fold art ship `srcset` variants. Login, signup, and verify load
the Turnstile widget immediately.

## Budget

Edit [`tools/site-perf/budget.json`](../../tools/site-perf/budget.json) when the
live site has a new honest baseline. Bump a threshold only after the change is
on production and the collector agrees.

`htmlBytes` counts the full anonymous document, including the intentionally
inlined `styles.css` `<style>` block (see
[the native document shell](../../packages/worker/start/routes/__root.tsx)). The
Vite build minifies raw CSS imports with esbuild, preserving public asset URLs.
That trade removes a render-blocking stylesheet round trip; do not "fix" an
`html-over-budget` finding by switching back to a `<link rel="stylesheet">`
without a product call. When landing CSS or below-fold marketing markup grows
for real product work (hero agents, testimonials, factory loop, primitive
widgets, and so on), raise `htmlBytes` to the new honest production size instead
of cutting the page.
