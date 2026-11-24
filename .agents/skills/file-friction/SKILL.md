---
name: file-friction
description: >
  File durable repo or package papercuts into the Kody factory. Use when a
  session hits leftover friction outside the ship-pr leftover pass. Ship-pr
  already files leftovers before Discord.
---

# File friction

Policy (when to file, ownership, how to judge fixes):
[docs/contributing/friction-log.md](../../../docs/contributing/friction-log.md).
API, qualify, and examples live in
[@kody/kody-factory](https://kody.codes/@kody/kody-factory) (`friction/file`).
Filed friction becomes a card (category friction) on the factory board. Keep
this skill thin
([Keep agent context lean](../../../docs/principles/lean-agent-context.md)).

**File** durable, recurring pain with a clear owner and a reproducible contract
gap. **Skip** one-off agent confusion, session-only nits, and noise that will
not help the next agent.

**Where:** always pass required
`target: { host: 'github' | 'kody', repo: string }`.

- Platform / this repo: `{ host: 'github', repo: 'kody-hq/kody' }`.
- Kody package: `{ host: 'kody', repo: '@owner/leaf' }`.

Run `kody:@kody/kody-factory/friction/file` hosted with
`npx @kodycodes/cli execute --org kody --context cloud --invoke kody:@kody/kody-factory/friction/file --params '…'`.
Pass `target` + `items` (a one-element `items` array is fine). Hosted runs emit
`@kody/factory.card.created`, which drives push and routing; `--local` runs skip
it. If nothing meets the bar, skip the call.
