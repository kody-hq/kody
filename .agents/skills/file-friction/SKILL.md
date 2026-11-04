---
name: file-friction
description: >
  File durable repo or package papercuts through the friction-log package. Use
  when a session hits leftover friction outside the ship-pr leftover pass.
  Ship-pr already files leftovers with friction-log/file before Discord.
---

# File friction

Policy (when to file, ownership, how to judge fixes):
[docs/contributing/friction-log.md](../../../docs/contributing/friction-log.md).
API, qualify, and examples live in
[@kentcdodds/friction-log](https://kody.codes/@kentcdodds/friction-log). Keep
this skill thin
([Keep agent context lean](../../../docs/principles/lean-agent-context.md)).

**File** durable, recurring pain with a clear owner and a reproducible contract
gap. **Skip** one-off agent confusion, session-only nits, and noise that will
not help the next agent.

**Where:** always pass required
`target: { host: 'github' | 'kody', repo: string }`.

- Platform / this repo → `{ host: 'github', repo: 'kody-hq/kody' }` (never raw
  `gh`).
- Kody package → `{ host: 'kody', repo: '@owner/leaf' }` (wakes Patch; no GitHub
  issue).

Prefer `kody:@kentcdodds/friction-log/file` for one or many leftovers via
prefer-local CLI execute
([prefer-local-cli-execute](../prefer-local-cli-execute/SKILL.md)). Pass
`target` + `items` (a one-element `items` array is fine). Use `./create` only
when you intentionally want its top-level single-issue fields: do not pass
`items` to `create`. If `--local` cannot run, fix the environment so local
works. Open API / MCP `api` cannot invoke this package export, and hosted MCP
`execute` is banned. Do not invent issues via `gh`. If nothing meets the bar,
skip the call.
