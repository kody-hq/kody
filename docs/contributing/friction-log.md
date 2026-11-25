# Friction log

File contributor papercuts as cards on the
[Kody factory](https://kody.codes/@kody/kody-factory) board (org `kody`), not as
files in this repo. For user-facing product feedback, use
[platform friction](../guides/platform-friction.md).

## When to file

File durable, recurring friction with a clear owner and a reproducible contract
gap, such as a missing setup step, misleading type, or brittle test. The next
agent should be able to act without your session. Fix obvious, low-risk
papercuts in scope and mention the fix; file only qualifying leftovers. Reuse
the title of an open card for the same papercut and leave soft-skipped items
unfiled rather than retrying under an alias.

## Where it belongs

Pass the required `target` for the owner of the contract:

- This repo: `{ host: 'github', repo: 'kody-hq/kody' }`.
- Another GitHub repo on the factory board:
  `{ host: 'github', repo: 'owner/repo' }`.
- An export, job, README, or other package contract:
  `{ host: 'kody', repo: '@owner/leaf' }`.

## How to fix

Fix the owning platform or package contract rather than adding aliases,
fallbacks, or caller-specific behavior. Use neutral examples or the existing
help destination. Ship clear bugs promptly; record `needs-kent` when a product
or ops decision is still needed.

## File an entry

Run `kody:@kody/kody-factory/friction/file` on Kody cloud (`--context cloud`)
with `target` and `items` (a one-element array is fine):

```bash
npx @kodycodes/cli execute --org kody --context cloud \
  --invoke kody:@kody/kody-factory/friction/file \
  --params '{"target":{"host":"github","repo":"kody-hq/kody"},"items":[{"title":"…","whatHappened":"…","whatYouWanted":"…","howToReproduce":"…","preliminaryInvestigation":"…"}]}'
```

Use the hosted command for the ship-pr friction step too: it emits the event
that routes the card. Keep ship-pr ticks local. Set `priority: 0` or
`security: true` for qualifying items that need immediate routing.

Add `"dryRun": true` to preview filing. See the
[factory package](https://kody.codes/@kody/kody-factory) for fields, card tags,
and nightly triage. In a nightly triage run, put `Fixes <card link>` in the PR
body and finish with `friction/record-outcome` as directed by the session
prompt. Use the
[file-friction skill](../../.agents/skills/file-friction/SKILL.md) outside
ship-pr's leftover pass.
