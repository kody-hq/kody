---
title: Kody weekly: small fixes and maintenance
date: 2026-06-05
description: Generated UI shows real tool errors and next steps, and package sources recover from missing repos.
order: 1
category: updates
placeholder: false
---

Here is what shipped in Kody from May 30 to June 5, 2026. This is a quiet week
focused on clearer errors and package source reliability.

## This week: small fixes and maintenance

Generated UI flows now show the actual error a tool returned, plus the next step
the server suggests, and render failures appear in the shell instead of a blank
screen ([#515](https://github.com/kody-hq/kody/pull/515)). Package source setup
also recreates a missing source repo instead of reusing a stale record
([#517](https://github.com/kody-hq/kody/pull/517)).

## More updates

- **Apps:** Improves generated UI error messages with the real tool error
  payload and next-step guidance. ([docs](https://kody.codes/docs/package-apps),
  [#515](https://github.com/kody-hq/kody/pull/515))

## Fixes

- **Packages:** Fixes package source setup failing when its backing repo had
  gone missing. ([#517](https://github.com/kody-hq/kody/pull/517))

## Try it

Open one of your package apps and, if a tool call fails, use the error and next
step it shows to fix it. See
[Package apps](https://kody.codes/docs/package-apps).

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
