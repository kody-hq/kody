# Follow CLI contract

Contract between origin (`followAdd` / `followList` / `followRemove`) and
`@kodycodes/cli` (`kody follow add` / `kody follow list` /
`kody follow remove`). The CLI lives in `packages/cli`. Origin exposes the
capabilities on MCP and the Open API. Product keyword: `follow_repo`. Domain:
`follow`.

Related to #3810.

## Commands

| CLI                                                 | Open API             | Capability     |
| --------------------------------------------------- | -------------------- | -------------- |
| `kody follow add @handle/name`                      | `POST /v1/follows`   | `followAdd`    |
| `kody follow add @handle/name --kind package\|repo` | `POST /v1/follows`   | `followAdd`    |
| `kody follow add @handle/name --events pushed`      | `POST /v1/follows`   | `followAdd`    |
| `kody follow list`                                  | `GET /v1/follows`    | `followList`   |
| `kody follow remove @handle/name`                   | `DELETE /v1/follows` | `followRemove` |

Both calls use the org the credential is bound to. That org owns the follow.
There is no feature flag.

### `followAdd`

```json
{ "name": "@ada/notes", "kind": "package", "events": ["published", "pushed"] }
```

`name` is required and must be `@handle/name` (`handle` is the owner org slug).
`kind` is optional: `package` or `repo`. When omitted, a package with that name
wins over a plain repo.

`events` is optional. A new follow without it gets every event the target can
send; repeating add without it keeps the stored choice. A plain repo only sends
`pushed`. Errors (no follow is written):

```text
Choose at least one event to follow.
Plain repos are never published, so @ada/notes can only be followed for pushes.
Pushes from @ada/notes need read access to it. A Use grant includes read; run-only access does not.
```

Changing events on an existing follow does not consume the create rate limit.

```json
{
	"follow": {
		"name": "@ada/notes",
		"kind": "package",
		"status": "active",
		"events": ["published", "pushed"],
		"created_at": "2026-10-15T00:00:00.000Z",
		"paused_at": null,
		"paused_reason": null,
		"last_delivery_skip_reason": null
	}
}
```

The response never includes follow ids, owner ids, package ids, or repo ids.

Repeating add for a target this org already follows returns that follow and does
not consume the create rate limit. If the row is paused and the caller still has
create-level access, add resumes it.

`paused_reason` is `target_missing` (the target was deleted or can no longer be
found) or `access_lost` (the follow's creator lost create-level access), or
null.

### `followList`

No inputs. Returns
`{ "follows": [ ...same object as followAdd... ], "recent_updates": [ ... ] }`
for the bound org, newest first. `recent_updates` holds up to 20 events no
enabled package subscription handled (see [Recent updates](#recent-updates)):

```json
{
	"name": "@ada/notes",
	"kind": "package",
	"event": "pushed",
	"occurred_at": "2026-10-15T00:05:00.000Z",
	"summary": "3 commits pushed to main: Fix typo"
}
```

### `followRemove`

```json
{ "name": "@ada/notes", "kind": "package" }
```

Deletes the bound org's follow of that target and returns
`{ "removed": { "name": "@ada/notes", "kind": "package" } }`. The name matches
the live target first, then the name stored on the follow, so a follow whose
target was deleted can still be removed. Removing a target the org does not
follow is an error:

```text
This org does not follow "@ada/notes".
```

## Access

Create (`followAdd`) and every later delivery re-check access. A missing target
and a target the caller cannot read are the same error:

```text
Follow target "@ada/notes" was not found.
```

| Target                                    | Create                                   | `follow.published`     | `follow.pushed`                                                             |
| ----------------------------------------- | ---------------------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| Public package or repo (`is_private = 0`) | Any signed-in caller                     | Still public, or pause | `package:read` on that package, or org-wide `package:read` for a plain repo |
| Private package                           | `package:read` on that package           | Same, else pause       | Same `package:read`, else skip push and leave the follow active             |
| Private repo                              | Org-wide `package:read` in the owner org | Same, else pause       | Same org-wide `package:read`, else skip push and leave the follow active    |

A `use` grant includes `package:read` and `package:execute`, so it can follow
and receive push for that package. A grant of only `package:execute` cannot:
create looks like not found, and push does not fire. Checks use
`checkPermission` / org-wide `package:read`, never the grant preset name. A
grant on one package does not grant push (or private create) for a plain repo.
Package owners cannot disable push follows.

Losing create-level access pauses the follow (`status: "paused"`, `paused_at`,
`paused_reason: "access_lost"`); a target that no longer exists pauses it with
`target_missing`. Paused follows are deleted after 30 days. Push that is not
allowed does not pause the row.

## Limits

30 new follows per org per hour (`checkRateLimit`, key
`follow-create:<follower org id>`). The 31st new follow in the window is:

```text
Follow limit reached for this org (30 new follows per hour). Try again in about an hour.
```

Deliveries are not rate limited. Fork auto-follow does not consume this budget.
There is no cap on how many follows an org may hold and no cap on pushes.

Triggered package runs use the existing subscription path: the follower org's
credits and, when the subscriber package has an enablement, that enabler's run
limits. At zero credits the invocation returns 429 before the handler runs.
Origin records `last_delivery_skip_reason: "zero_credits"` on the follow, does
not throw, and does not queue a retry or send a notice.

### Recent updates

When the follower org has no subscription with an `on` enablement for the topic
(no subscriber, or only subscribers without a live enablement), delivery stores
a row in `follow_recent_updates` instead, after the target and access recheck.
One row per published commit, and one per coalesced push window (`dedupe_key`
makes a retried flush a no-op). Rows are scoped by `follower_org_id` and
`follow_id`; inserts only land when that follow belongs to that org. Each follow
keeps its newest 20; follow maintenance deletes rows older than 30 days and rows
whose follow is gone, and removing a follow deletes its rows. Handled events,
events a subscription's filters drop, zero-credit (429) skips, failed handlers,
incomplete subscription discovery, paused follows, and skipped pushes are never
recorded, and recording charges no credits. Org hard purge deletes the table by
`follower_org_id`; it is not exported.

## Topics

Manifests declare `follow.published` and/or `follow.pushed`. Filters only narrow
delivery. `follow.published` fires when a package `published_commit` moves.
`follow.pushed` fires when the default branch moves, coalesced into one pending
row per target for five minutes, at most 20 commits on the event.

Forking a community listing creates a follow of the upstream package. A fork
whose listing row still exists already has that follow. A listing pin move
delivers `community.fork.upstream_updated` from this pipeline with that event's
payload, one event per fork behind the new pin.

## CLI notes

- Print `name`, `kind`, and `status`. Do not invent ids the API does not return.
- Exit non-zero on the not-found string and on the rate-limit string. Do not
  special-case "permission denied"; origin will not send one for a follow the
  caller cannot read.
- `kody follow list` prints an empty list when the org follows nothing,
  including when every follow is absent. Paused rows are included so the user
  can see them.
