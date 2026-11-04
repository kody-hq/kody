---
title: Kody weekly: Search finds your saved values and connectors
date: 2026-04-10
description: Search now returns saved values and connectors, plus 2 more updates to outbound email and generated UI rendering.
order: 1
placeholder: false
---

Here is what shipped in Kody from April 4 to April 10, 2026. This is a short
week: `search` can find more of what you have saved, and outbound email and
generated UI rendering get steadier.

## Search finds your saved values and connectors

### What shipped

The `search` tool now returns persisted values and saved connectors as their own
result types, next to capabilities, skills, apps, and secrets. You can open one
directly by passing `entity` as `"{id}:{type}"` with the new `value` and
`connector` types. Exact name matches on a value or connector now win ties
against similarly named capabilities.

### Why it matters

Your agent no longer has to guess whether you already stored a preferred org, a
base URL, or an OAuth connector for a provider. One search shows what exists, so
it reuses your saved credentials and settings instead of asking you again or
creating duplicates.

### Example

Ask for the details of a saved connector or value by id:

```json
{ "entity": "github:connector" }
```

```json
{ "entity": "user:preferred_org:value" }
```

Docs: [Search and execute](https://kody.codes/docs/search-and-execute) · PRs:
[#139](https://github.com/kody-hq/kody/pull/139),
[#141](https://github.com/kody-hq/kody/pull/141)

## More updates

- **Email:** Sends outbound email, such as password resets, through Cloudflare
  Email. ([#137](https://github.com/kody-hq/kody/pull/137))
- **Apps:** Improves generated UI rendering. The shell now mounts the model's
  HTML into a stable document instead of rewriting the whole page on each
  render, and scripts load in order with inline scripts kept in their own scope.
  ([#146](https://github.com/kody-hq/kody/pull/146))

## Fixes

- **Email:** Fixes outbound email by sending to Cloudflare's documented email
  sending endpoint with a default API base URL.
  ([#143](https://github.com/kody-hq/kody/pull/143),
  [#144](https://github.com/kody-hq/kody/pull/144))

## Try it

Ask your agent to search for the connectors and values you already saved, then
open one with `entity`.
[Search and execute](https://kody.codes/docs/search-and-execute) shows how the
two tools work together.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
