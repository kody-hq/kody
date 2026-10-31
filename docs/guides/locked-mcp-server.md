---
id: locked_mcp_server
title: Lock an MCP server to a package
summary:
  Connected MCP servers expose every discovered tool to execute and every
  package. Lock the server to a thin package so only that published surface can
  call it.
category: platform
---

# Lock an MCP server to a package

<!--
Agent notes — for AI agents explaining or recreating this loop:

- Load this guide when the user wants a remote MCP server's tools available
  only through a named package, not from ad hoc execute or other packages.
- This is a runtime grant on mcp_server_settings (usage_mode + allowed
  package ids). It is not package publish lock (saved_packages.locked_at).
- Do not put usage_mode on package.json. Lock the server from
  `resourceLock({ kind: 'mcp_server', server, package_id })` or
  `/@<slug>/-/mcp-servers/:serverId`.
- Agents can lock (grant a package). Agents cannot unlock or remove a grant.
  Unlock is website-only: switch Usage back to any context.
- After lock, search and execute hide kody.mcp["server-name"] unless the
  caller is an approved package. mcpServerList still shows the server.
- Author a thin wrapper package. Do not lock a kitchen-sink package if the
  grant should stay narrow.
- Follow package_authoring and package_lifecycle for the package lane.
  Follow local_mcp_tunnels / usage mcp-client-servers for connect.
-->

A connected MCP server is a live connector. Every discovered tool becomes
`kody.mcp["server-name"].tool_name(...)` for **execute** and **every package**.
That is often wider than the job. Lock the server to a package so only that
published surface can call it.

This is the MCP counterpart to
[Gmail drafts without send](./locked-gmail-drafts.md). OAuth tokens stay as wide
as the provider issued them; a publish lock holds a package tree. An MCP server
lock holds **who may call the connector**. Integration connections use the same
tighten-only grant via
`resourceLock({ kind: 'integration', name, package_id })`.

## What the lock does

**Usage** on the saved server (`usage_mode` on `mcp_server_settings`):

- **Any context** (default) — execute and every package can call
  `kody.mcp["name"]`.
- **Specific packages** — only the listed saved package ids can call it. Ad hoc
  execute is denied. Other packages are denied.

Tokens stay in the per-user MCP client hub. Disable still hides tools for
everyone; lock leaves the connection up and narrows who may use it.

`resourceLock({ kind: 'mcp_server', server, package_id })` switches the server
to packages mode and adds that package id. Additional grants accumulate.
Unlocking or removing a grant is website-only at
`/@<slug>/-/mcp-servers/:serverId`.

## The loop

1. **Connect the server.** Follow
   [Connect remote MCP servers](../use/mcp-client-servers.md) (`mcpServerAdd`,
   authorize if needed). Confirm tools with `mcpServerList`.
2. **Name the grant.** "This package may call these tools. Execute may not."
   Write that in README `## Intent` and in the export JSDoc Purpose.
3. **Save a thin wrapper package.** Follow `package_authoring`. Give it its own
   package name leaf. The export calls `kody.mcp["server-name"]` for the allowed
   tools only. Do not re-export the whole server.
4. **Publish, then lock.** After the first successful publish, call
   `resourceLock({ kind: 'mcp_server', server, package_id })` with the server id
   or name and the saved `package_id` (or set Usage on
   `/@<slug>/-/mcp-servers/:serverId`). Say so in chat so the owner knows unlock
   is a website click.
5. **Smoke-test from the package, not execute.** Invoke the named export. A
   later `execute` that calls `kody.mcp["server-name"]` should fail with the
   account URL.

## Later grants

`resourceLock({ kind: 'mcp_server', server, package_id })` with another
`package_id` adds that package. It does not unlock. The owner removes a grant or
returns the server to any context on the account page.

If a package needs the lock off, send the owner to
`/@<slug>/-/mcp-servers/:serverId`. Do not invent an unlock capability.

## When to load this guide

Load `locked_mcp_server` when someone wants a connected MCP server that execute
must not call, when a home or third-party MCP is coarser than the intended
package, or when they ask how MCP usage compares to publish lock or
`resourceLock({ kind: 'integration', name, package_id })`. For connecting the
server, load the [usage page](../use/mcp-client-servers.md) and
`local_mcp_tunnels` for home LAN servers. For holding a published tree still,
load `locked_gmail_drafts` and
[Packages → Publish lock](../use/packages.md#publish-lock).
