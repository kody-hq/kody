# Schedules and freshness

| When (UTC)                       | Who               | What                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*/5` during 00:30–06:10         | Production worker | Staging export: resume the oldest stranded day (progress without summary, today − ≤14 days), else stage today (cheap no-op once complete)                                                                                                                                                                                                                                  |
| Every 5 min outside 00:30–06:10  | Production worker | Staging catch-up: resume the oldest stranded day (progress without summary, today − ≤14 days); cheap no-op otherwise                                                                                                                                                                                                                                                       |
| 06:15                            | Production worker | Staging watchdog: missing today's summary with no older stranded days, today complete while earlier days are stranded, catch-up with no advance for 2h, or the oldest stranded day 2+ UTC days behind, fails → Sentry. A one-day backlog that is still advancing does not page                                                                                             |
| Hourly `:45`                     | Control plane     | Seal recent complete days from the sealed paced D1 nights and staging summaries                                                                                                                                                                                                                                                                                            |
| Hourly `:45`                     | Control plane     | Yesterday's full seal still blocked (any reason except a missing staging summary) → Sentry, fingerprint `dr / full-seal-blocked / <reason>` or `<reason>:<source>`                                                                                                                                                                                                         |
| Hourly `:45`                     | Control plane     | Seal scan stops at its 20,000 R2 call budget (`full-backup-seal-scan-stopped`, `r2-call-budget-exhausted`) and the next hour resumes; stopping on yesterday reports `dr / full-seal-blocked / r2-call-budget-exhausted`. Hitting the Workers subrequest limit stops the scan at the first failed call → Sentry `dr / seal-scan-subrequest-limit / worker-subrequest-limit` |
| On skip                          | Production worker | A storage identity left out after 3 aborted attempts → Sentry, fingerprint `dr / export-storage-identity-skipped`                                                                                                                                                                                                                                                          |
| `*/5` during 00:30–06:10         | Production worker | Paced D1 walk (`dr_d1_paced_backup`): APP_DB, AUDIT_DB, and JOBS_DB when `DR_D1_PACED_BACKUP_ENABLED=true`                                                                                                                                                                                                                                                                 |
| Every 5 min outside 00:30–06:10  | Production worker | Paced D1 catch-up: resume the oldest incomplete paced night (today − ≤14 days)                                                                                                                                                                                                                                                                                             |
| 06:15                            | Production worker | Paced D1 watchdog: tonight's paced staging/sealed manifests still missing → Sentry                                                                                                                                                                                                                                                                                         |
| Hourly `:45` outside 00:30–06:10 | Production worker | Paced D1 freshness: yesterday's staged sources that have yet to seal → Sentry. The 06:15 watchdog checks today's sources.                                                                                                                                                                                                                                                  |
| Sunday 07:00–08:59               | Production worker | Paced D1 restore drill: resumable per source, verify tip checksums; failure → Sentry                                                                                                                                                                                                                                                                                       |

## Stranded staging days (manual finish)

Failure mode: the nightly exporter hard-stops when the window closes, so a night
with too much work leaves `staging/{day}/exporter/progress.json` without
`exporter/summary.json`. The 06:15 watchdog pages when tonight is genuinely
incomplete and not deferred for older backlog; without a summary the day can
never seal. Nightly and daytime catch-up ticks (table above) should finish a day
well inside 24h: Mailbox and RunLog read 8 owners at a time inside a ~45s tick,
instead of one owner per ~5s serial round trip. When more than one day in the
lookback is stranded, both lanes finish the oldest first so earlier days seal
before later nights stack more backlog. The hourly control-plane seal (16-day
lookback, matched to catch-up plus overnight gap) then seals it — no operator
action needed.

Operate manually when catch-up is stuck, the day has already fallen outside the
catch-up lookback, or you want the day finished immediately:

```sh
DAY='YYYY-MM-DD'
curl --fail-with-body \
  --request POST "$PRIMARY_WORKER_ORIGIN/__maintenance/dr-export" \
  --header "Authorization: Bearer $DR_RESTORE_SECRET" \
  --header "Content-Type: application/json" \
  --data "{\"day\": \"$DAY\"}"
```

Each request runs up to 5 resume ticks (`maxTicks`, 1–10) with the normal ~45 s
budget and lease semantics, so it is safe alongside scheduled catch-up ticks.
Repeat until the response reports `"summaryWritten": true` (or
`"reason": "already-complete"`). The endpoint is resume-only: a day with no
staged progress returns `"reason": "no-staged-progress"` instead of starting a
fresh export for a past day. After the summary exists, the next hourly
control-plane seal covers the day if it is within the 16-day seal lookback;
otherwise seal it from the admin UI (`POST /actions/seal-day`).

From Kody MCP `execute`, pass `"maxTicks": 1` and loop until `summaryWritten` or
`already-complete`. Each tick can use the full ~45 s export budget; `maxTicks`
2+ holds the MCP request open past the client timeout (~60 s). Shell `curl` can
keep the default of 5.

Page yourself on paced freshness or watchdog Sentry issues, seal failures
(`paced-d1-seal-missing`, `paced-d1-seal-corrupt`), paced drill failures, or
unexpected disablement of the enable gates. REST-era days are not restorable;
their immutable media stays unchanged until it ages out.
