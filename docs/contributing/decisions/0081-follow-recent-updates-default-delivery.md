# 0081: Follow Recent updates are the default delivery

- **Status:** accepted
- **Date:** 2026-10-25

## Context

A follow turns a public package's or repo's `follow.published` / `follow.pushed`
events into package subscription runs in the follower's workspace. Without a
subscription that handles the topic, delivery did nothing visible. In practice
that is the normal case: one account held 39 follows and no package subscribed
to either topic, so every follow delivered to nothing and the UI did not say so.
[0073](./0073-community-listing-follows-promote.md) made listings follow
`published_commit` automatically, which grows the number of follows that nobody
handles.

The existing `last_delivery_skip_reason` column stores only the latest
zero-credit skip, with no event detail or history, so it cannot back a list.

## Decision

Give follows a built-in default delivery: when no subscription in the follower
org has an `on` enablement for the topic, store the event as a Recent update in
`follow_recent_updates`, keyed by org and follow.

- Record only after the existing target and access recheck; a target the org can
  no longer read pauses the follow (or skips the push) and records nothing.
- Record a coalesced push window once, and a published commit once, via a
  per-follow `dedupe_key`.
- Bound it: the newest 20 per follow, 30 days, cleaned by follow maintenance.
- Charge nothing. Handled events keep today's behavior and are not recorded;
  zero-credit skips and failed handlers are not recorded either.
- The Follows page and the package Follow panel say which selected events no
  package handles, link to package subscriptions, and render the list.
  `followList` returns `recent_updates`; no new MCP capability.

## Consequences

Following something is useful without writing a package, and the UI is honest
about unhandled events. The follow store gains one org-owned table that hard
purge deletes and export skips. Recent updates are a short history, not an
inbox: they are not read-tracked, notified, or kept past the cap. Revisit if
people want notifications without a package, or if handled events should also
appear in the list.
