# 0022: Retire the values primitive

- **Status:** accepted
- **Date:** 2026-08-19

## Context

Values were the readable twin of secrets: named non-secret config, scoped `user`
/ `app` / `session`, first-class in `search`, editable at `/account/values`.
Production D1 (2026-08-19) does not support that job.

All 122 `value_entries` rows are `user` scope (zero `app` / `session`). The
operator account holds 66. Seventeen other users hold 56; five of those users
have only `onboardingChecklistDismissed` (a platform UI flag). The rest are
OAuth client ids, chunked blobs, or a handful of package knobs. Power-user
packages already call user values "legacy" and persist config in repos plus
`packageStorage()`. Memories already hold the overlapping facts (timezone,
address). ADR [0003](./0003-repos-as-base-primitive.md) named "documents live
chunked in values" as the problem repos were meant to end. Admin insights counts
memories and secrets, not values.

The leftover unique job — deterministic cross-package `valueGet({ name })` — is
a handful of Discord/org ids. That does not justify a four-capability domain, a
search entity that prints stored contents, an account screen, and two D1 tables.
Secrets stay: their contract (raw values never enter prompts) is unique. Values
were the readable twin; we do not need a twin.

## Decision

Retire the values primitive. Absorb its jobs into memories (durable facts and
preferences), package storage (runtime state and package-owned settings), repos
(versioned config), integrations (OAuth client ids), and a `users` column for
platform onboarding dismissal. Do not add a thinner "account settings" primitive
unless, after the soak, something still has no home.

## Destination map

Do not invent a replacement primitive.

| Job                                 | Destination                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| Platform UI dismiss                 | `users.onboarding_checklist_dismissed_at`                                     |
| Durable facts / preferences         | memories (`meta_memory_*`, verify-first)                                      |
| Package runtime state / cache       | `packageStorage()`                                                            |
| Versioned calibration               | plain repo (live-at-HEAD)                                                     |
| Package-owned knobs                 | `packageStorage()` or a file in that package repo                             |
| Shared ids used by several packages | owning package export, or one small settings package others statically import |
| OAuth client ids                    | integrations / platform OAuth apps                                            |
| Credentials                         | secrets                                                                       |

## Consequences

MCP, search, `/account/values`, export/deletion, and entitlements byte math lose
a surface. Shared D1 write traffic for `value_entries` goes away
([0002](./0002-data-placement.md) listed values as D1 config; that placement
becomes moot when the tables drop). Community listings and packages that still
say `valueGet` need a migration pass. Revisit only if a real cross-package
config need appears that memories plus a settings package cannot cover.

## LATER-NOTE (2026-08-24)

Writes and agent-facing surfaces are gone. `valueGet` / `valueList` /
`valueDelete` remain as an unadvertised drain until the D1 tables drop.

## LATER-NOTE (2026-10-16)

The drain, `/account/values`, the unadvertised values guide, and data-inventory
reads are removed. `value_entries` and `value_buckets` drop in migration
`0159-drop-value-tables.sql`. Production rows were already 0.

## LATER-NOTE (2026-10-19)

Retirement is complete in this repo. Do not add `account_settings`, `user_kv`,
or a new MCP domain to replace values. Do not auto-write memories from leftover
rows. Secrets stay.
