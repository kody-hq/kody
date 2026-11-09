---
title: Kody weekly: Browse a package's files before you install it
date: 2026-08-21
description: A read-only files explorer for published packages, plus 7 more updates and 4 breaking changes to connectors, services, values, and tokens.
order: 1
category: updates
---

Here is what shipped in Kody from August 15 to August 21, 2026. This week you
can browse published package files, sign in with Discord, and add a second
account to an integration. Kody also retires a few primitives in favor of
simpler ones, so four changes need action: see Breaking changes below.

## Browse a package's files before you install it

### What shipped

Every community listing and every saved package of yours now has a read-only
files page at `/@username/kodyId/files`. It shows the published snapshot as a
collapsible file tree, renders text files, and links each file by path. You
browse without opening a repo session.

### Why it matters

Before you install a community package, you want to see what it does with your
credentials and data. Reading the source takes a click instead of a fork, and
you can link a teammate straight to the file you are asking about.

### Example

Open a community listing, select its files link, and open the package's
`package.json` to see its exports, then the export you plan to call.

Docs: [Package sharing](https://kody.codes/docs/package-sharing) · PRs:
[#1545](https://github.com/kody-hq/kody/pull/1545)

## More updates

- **Orgs:** Adds sign in with Discord, which can also add you to the official
  Kody Discord, and self-service account deletion from account settings.
  ([#1595](https://github.com/kody-hq/kody/pull/1595),
  [#1612](https://github.com/kody-hq/kody/pull/1612),
  [#1620](https://github.com/kody-hq/kody/pull/1620))
- **Credentials:** Lets you add another account to an integration without
  replacing the first, and makes disconnect and delete undoable for a short
  window. ([#1574](https://github.com/kody-hq/kody/pull/1574))
- **Credentials:** Emits `integration.auth.succeeded` and
  `integration.auth.failed` so packages can watch connection health.
  ([#1525](https://github.com/kody-hq/kody/pull/1525),
  [#1516](https://github.com/kody-hq/kody/pull/1516))
- **Credentials:** Signs JWTs with EdDSA from an Ed25519 private key secret.
  ([#1504](https://github.com/kody-hq/kody/pull/1504))
- **MCP:** Supports confidential OAuth clients for MCP hosts that need static
  credentials. ([#1621](https://github.com/kody-hq/kody/pull/1621))
- **Packages:** `package_get` shows the callable functions and referenced types
  on each export. ([#1502](https://github.com/kody-hq/kody/pull/1502))
- **Community:** Adds a Newest sort to the community catalog.
  ([#1623](https://github.com/kody-hq/kody/pull/1623))

## Fixes

- **Execute:** Fixes destructuring `kody.mcp`, so `const { home } = kody.mcp`
  works in package code. ([#1537](https://github.com/kody-hq/kody/pull/1537),
  [#1561](https://github.com/kody-hq/kody/pull/1561))

## Breaking changes

- **MCP:** Remote connectors are removed. **Action:** run your home or local
  tools as an MCP server, add it on your MCP servers page, and call it through
  `kody.mcp`. ([#1511](https://github.com/kody-hq/kody/pull/1511))
- **Packages:** Package services are removed, and publish rejects packages that
  still declare `kody.services`. **Action:** move that work to jobs, workflows,
  or subscriptions. ([#1552](https://github.com/kody-hq/kody/pull/1552))
- **Platform:** Values are retired. **Action:** move stored values into
  memories, `packageStorage()`, repos, secrets, or integrations. Your agent gets
  migration steps if you still have values.
  ([#1532](https://github.com/kody-hq/kody/pull/1532))
- **Credentials:** Package invocation tokens now belong to one saved package,
  and the URL names the owner and package. **Action:** create a token per
  package and update callers to the new URL.
  ([#1553](https://github.com/kody-hq/kody/pull/1553))

## Try it

Open any community listing, browse its files, and read the export you would call
before you install it.

Questions or feedback? Join us on the
[Kody Discord](https://kcd.im/kody-discord).
