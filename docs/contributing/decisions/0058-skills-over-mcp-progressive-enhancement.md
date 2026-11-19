# 0058 — Skills over MCP ship as a flagged progressive enhancement

- **Status:** accepted
- **Date:** 2026-10-07

## Context

[0015](./0015-skills-over-mcp-wait.md) waited on SEP-2640 (extension id
`io.modelcontextprotocol/skills`) until it left draft, a host consumed it live,
and the SDK v2 lane could register custom methods. Today the SEP is Final, and
the SDK v2 lane supports custom methods (`setRequestHandler` with a method
schema) and extensions. Host support is still partial: ChatGPT, fast-agent, and
MCP Inspector are Partial on the official matrix; Claude and Cursor have no
Skills column yet. Most revisit conditions are met, enough for an opt-in
experiment, not enough for a default-on surface.

## Decision

Ship Skills over MCP behind the `mcp-skills-extension` feature flag, default off
with `defaultAudience: experiments_opt_in`, as a progressive enhancement on the
modern (2026-07-28) MCP lane only.

- Packages stay the source of truth: `skills/<name>/SKILL.md`. No `kody.skills`
  manifest key.
- Publish validates skills and stores digests in an index; MCP adapts that index
  when the client advertises `io.modelcontextprotocol/skills` and the flag is
  on.
- The tool surface stays `search` / `execute` / `api`. The instructions stub
  stays thin and vendor-neutral; it does not advertise skills.

```text
flag off, or client without the extension -> MCP surface unchanged
flag on + extension advertised            -> skills/list, skills/get, skill:// resources
any host                                  -> search package:@you/pkg#skills/x/SKILL.md
```

## Consequences

- Flag-off behavior is identical to before. The legacy lane never serves skills.
- Supporting hosts get `skills/list`, `skills/get`, and `skill://` resources
  scoped to packages the connection can use; other hosts are untouched.
- Non-supporting hosts keep the search-and-read path from 0015 for skill files.
- Supersedes 0015. Guide: [package skills](../../guides/package-skills.md).
- Revisit (flip the default or delete the flag) once Claude or Cursor consume
  MCP-served skills live. Delete the flag and gate sites when the experiment
  ends.

## Update (2026-11-19)

Promoted to everyone. The `mcp-skills-extension` flag and its gate sites are
deleted; the only remaining condition is that the client advertises
`io.modelcontextprotocol/skills` on the request.
