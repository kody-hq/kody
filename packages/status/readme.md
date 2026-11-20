# kody status worker

The public status page for kody, served at
[status.kody.codes](https://status.kody.codes). It is deliberately a separate
Cloudflare Worker with its own storage so it stays up when the main worker's
deploys, code, or database are broken (see decision record 0004).

## How it works

- A cron trigger runs one probe pass per minute:
  - `GET /health` and `GET /health/components` on the primary origin
    (`kody.codes`)
  - the unauthenticated OAuth challenge on `/mcp`
  - package-runtime liveness `GET /__runtime/health` on `kody.run` (JSON
    `status: "ok"`; an apex 302 is not up)
  - jobs-worker `GET /health` and `GET /health/components` over a service
    binding (no public jobs hostname; JOBS_DB rides on the Jobs component)
  -     MCP execute evidence: a successful authenticated execute completion in the
    previous minute (read cheaply from `/health/components`) skips a synthetic.
    Otherwise the worker runs at most one authenticated
    `POST /__maintenance/mcp-execute-health` per rolling hour. Failed attempts
    consume that budget. Public `/` and `/status.json` never trigger that
    execute. When the Durable Object's last-success timestamp is already outside
    the one-minute skip window, those public reads refresh `executeEvidence`
    from origin `GET /health/components` (same cheap timestamp-only field the
    cron uses; a down origin fails open to stored state; persist and cron
    synthetic writes merge with any newer timestamp written during those
    fetches). The public card treats organic or synthetic success in the last
    hour as recently verified — organic traffic alone keeps the card green; the
    hourly synthetic is an optional fallback when traffic is quiet. Missing or
    stale telemetry is unknown, not an outage, and does not change overall
    status or hide other incidents.
- Public storage cards are the main-worker bindings that take the product down
  (`app_db`, `kv`, `assets`). Operator `GET /health/components` reports
  `audit_db` as well; it is not a public card and does not open incidents or
  send alert email.
- A single `StatusStore` Durable Object (SQLite) stores per-minute samples (24
  h), daily uptime rollups (90 days), incidents, and sent notifications.
- A component opens an incident after three consecutive probe failures (about
  three minutes) and resolves it after two consecutive successes. The thresholds
  are independent (`failureThreshold` and `recoveryThreshold` in
  `incidents.ts`), and apply to every component.
- Day bars and the uptime percentage follow those opened incidents. Isolated
  probe failures below the threshold stay in the 24h sample log only — they do
  not increment daily failed counts or paint a day amber. A day turns amber when
  an incident covered it for under an hour and under 5% of that day's probes
  failed; red when the incident lasted an hour or more, or at least 5% of probes
  failed. Cards start at the first day with samples instead of padding empty
  leading days.
- Operator alert emails go to `ALERT_EMAIL_TO` through the Cloudflare Email REST
  API: one email when an outage starts, at most one reminder per day while it
  lasts, one all-clear when everything has recovered, all under a daily cap
  (`STATUS_ALERT_DAILY_LIMIT`). Alert links use `STATUS_PAGE_URL`
  (`https://status.kody.codes`).

When an incident opens or resolves, the worker also POSTs a small JSON payload
to the main worker (`POST /__maintenance/status-incidents`) when the shared
Worker secret `STATUS_INCIDENT_EVENT_SECRET` is set. That path fans
`status.incident.opened` / `status.incident.resolved` to admin package
subscriptions. The notify is fire-and-forget with a short timeout so a down or
missing secret cannot stall probes or email. When the secret is unset, packages
can reconcile from `GET /status.json`.

Resolved incidents may also carry an optional operator retrospective (what
happened, impact, timeline, cause, what we did, what we will change). Probes
remain the source of truth for open vs resolved. The writeup is attached
narrative, stored on `StatusStore`, and shown on the public page inside a
`<details>` block so the incident list stays glanceable. `/status.json` includes
`retrospective` on each incident (`null` when none is published).

Publish or replace a writeup with a bearer POST to the status worker itself —
not origin — so a down main worker cannot block it:

```bash
curl -fsS -X POST \
  "https://status.kody.codes/__maintenance/incidents/10/retrospective" \
  -H "Authorization: Bearer $STATUS_INCIDENT_EVENT_SECRET" \
  -H "Content-Type: application/json" \
  --data @packages/status/retrospectives/jobs-2026-09-02.json
```

`STATUS_INCIDENT_EVENT_SECRET` is the same Worker secret already synced from
GitHub Actions. When it is unset, the route returns 503. Open incidents return
409; unknown ids return 404. There is no public unauthenticated write.

The secret lives only in GitHub Actions, so the usual way to publish is the
`📝 Status Incident Retrospective` workflow
(`status-incident-retrospective.yml`) from main with `incident_ids`
(comma-separated, for example `12,13,14,15,16`), `retrospective_file` (a
committed file under `packages/status/retrospectives/`), and
`confirm: publish status retrospective <incident_ids>`. Agents dispatch it
through `@kentcdodds/github` as kody-bot.

The 2026-09-02 Jobs incident payload lives at
`packages/status/retrospectives/jobs-2026-09-02.json` (status incident id 10).
The 2026-11-20 Western Europe outage payload lives at
`packages/status/retrospectives/app-2026-11-20.json` (status incident ids 12 to
16).

A resolved incident that turned out to be health-check-only can be deleted with
a bearer `DELETE` on the same host:

```bash
curl -fsS -X DELETE \
  "https://status.kody.codes/__maintenance/incidents/11" \
  -H "Authorization: Bearer $STATUS_INCIDENT_EVENT_SECRET"
```

The secret lives only in GitHub Actions, so the usual way to run this is the
`🧹 Status Incident Delete` workflow (`status-incident-delete.yml`) from main
with `incident_id` and `confirm: delete status incident <id>`. Agents dispatch
it through `@kentcdodds/github` as kody-bot.

The delete removes the incident row and recomputes `daily_stats.failed` for the
days it covered, so the day bar loses its amber or red marker. Days no other
incident covers drop to zero failed. Days shared with another incident only lose
the deleted span's failed samples, or one failure per incident minute once those
samples are past the 24h retention. Open incidents return 409, unknown ids 404,
and an unset secret 503. Alert emails and `status.incident.*` package events
already sent for the incident are not retracted.

## Retrospectives

Every resolved incident gets an impact check. The outcome decides whether it
gets a public retrospective or is deleted.

1. **Start with the impact-check queries** for the incident window (open time
   minus a few minutes through resolve time):
   - Workers analytics per minute for the main worker: requests, errors, and 5xx
     by status.
   - Sentry events for the window compared with the baseline before it.
   - D1 analytics for the affected database: read and write queries, rows, and
     latency per minute.
   - Run errors: failed jobs and execute runs in the window.
2. **Real user impact** means Workers errors, 5xx responses, or Sentry events
   above baseline during the window. That incident requires a retrospective,
   published within 3 business days of resolve:
   - Write the payload at
     `packages/status/retrospectives/<component>-<YYYY-MM-DD>.json` using the
     existing fields (`whatHappened`, `impact`, `timeline`, `cause`,
     `whatWeDid`, `whatWeWillChange`). `component` is the status component id
     (for example `app_db`) and the date is the incident's start day in UTC.
   - Commit the file, then publish it with the
     `POST /__maintenance/incidents/:id/retrospective` command above.
3. **Health-check-only** means the probe failed but none of those signals moved.
   Record the evidence (the query results and the likely cause) in the PR,
   issue, or thread that approved the cleanup, then remove the incident with
   `DELETE /__maintenance/incidents/:id`. Example: status incident 11 (`app_db`,
   2026-10-12 13:21:14Z–13:22:11Z) had 0 Workers errors, 0 Sentry events, and
   normal D1 reads; a D1 write burst likely slowed the probe, so it was deleted.

Changing incident-opening thresholds is a separate decision; do not adjust them
as part of an incident cleanup.

## Provider incidents (Cloudflare)

Each cron tick also fetches Cloudflare's public Statuspage feed
(`incidents/unresolved.json`, no auth, short timeout) and caches a filtered
subset in the Durable Object (~60s refresh, stale-tolerant for a few minutes).
Only incidents whose affected components intersect products kody runs on are
kept: Workers, D1, R2, Workers KV, Durable Objects, Queues, Vectorize, Email
Routing, and Access. Regional PoPs, Stream, Magic Transit, and other unrelated
products are dropped.

When that filtered list is non-empty, the status page renders a clearly
separated **Provider incidents (Cloudflare)** section. It is provider-declared
context only — never merged into kody's measured health or uptime numbers. If
the Statuspage API is slow or unreachable, the page omits the section (fail
soft). Outage alert emails get one annotation line per active relevant incident
(`Possibly related Cloudflare incident: …`); alerts are never gated or
suppressed based on provider status.

## Routes

| Path                                              | Purpose                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `/`                                               | Public status page (HTML)                                                       |
| `/status.json`                                    | Snapshot as JSON                                                                |
| `POST /__maintenance/incidents/:id/retrospective` | Operator writeup on a resolved incident (bearer `STATUS_INCIDENT_EVENT_SECRET`) |
| `DELETE /__maintenance/incidents/:id`             | Delete a resolved health-check-only incident (same bearer)                      |
| `/health`                                         | Liveness for the status worker itself                                           |
| `/favicon-operational.png`                        | Favicon when all measured components are up                                     |
| `/favicon-down.png`                               | Favicon while a kody incident is open                                           |
| `/favicon-unknown.png`                            | Favicon when status data is unavailable                                         |
| `/favicon.ico`                                    | 302 to the current overall-status PNG (30s cache)                               |
| `/status-breakout*.js`                            | Browser modules for the opt-in "while you wait" game                            |

The HTML `<link rel="icon">` (and apple-touch icon) is chosen from
`overallStatus` on each render. The page reloads every 60 seconds, so an open
tab picks up a new icon when an incident opens or resolves. `/favicon.ico`
follows the same snapshot so clients that ignore `<link>` tags stay in sync.
Provider incidents do not change the favicon — they stay corroborating context
only.

## While you wait (Breakout)

When `overallStatus` is not `operational`, the page offers **Play while you
wait**: Breakout played with the page itself. The cards fly into a brick wall,
and the ball shatters real words, status dots, and day bars into falling debris.
Red incident days explode, amber days split off another ball, and a card or the
banner shatters once everything inside it is gone. While a game runs it polls
`/status.json` every 20 seconds and shows a "Kody is back" toast when the
overall status turns operational. While everything is operational, the only
entry point is a low-key **Play Breakout** link at the end of the footer. Add
`?play` to the URL to show the full **Play while you wait** button anyway (for
testing).

The game is progressive enhancement in `public/status-breakout*.js` (plain
browser modules, no dependencies, nothing loaded from the main worker). Without
JavaScript the page is unchanged and refreshes through a `<noscript>` meta
refresh. With JavaScript, a small inline script in `<head>` schedules the
60-second reload before any module loads (so a slow or failed module never stops
the refresh) and records the timer id on `<html data-refresh-timer>`; starting a
game clears it, and quitting reloads the page. The pure collision math in
`status-breakout-physics.js` has node tests, and `tsconfig.browser.json`
typechecks the modules against DOM types.

## Deploy

Deployed by `.github/workflows/deploy.yml` (path-filtered job, like the backup
control plane) with `npm run status:deploy`. The `CLOUDFLARE_API_TOKEN` Worker
secret is synced at deploy time from the Email Sending-only
`CLOUDFLARE_STATUS_API_TOKEN` GitHub secret (never the deploy token); the deploy
fails when that secret is unset. Without the Worker secret, alert emails are
skipped and logged.

Wrangler attaches `status.kody.codes` as a custom domain. The deploy healthcheck
probes that host's `/health`. Other component probes do not depend on the status
hostname.
