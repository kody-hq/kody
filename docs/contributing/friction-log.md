# Friction log

Contributor and agent papercuts while working in this repository live as
friction cards on the [Kody factory](https://kody.codes/@kody/kody-factory)
board (org `kody`). They are not files in the tree.

This is not [platform friction](../guides/platform-friction.md). That guide is
for user-facing Kody product feedback. This page is for developing the
`kody-hq/kody` repo: confusing docs, a test that only fails locally, a command
that needs a secret handshake, a type that lies.

This page is the policy for humans and agents: when to file, where it belongs,
and how to judge fixes. The filing API, qualify rules, and the nightly card run
live in [@kody/kody-factory](https://kody.codes/@kody/kody-factory)
(`friction/file`). Do not write entries under `.agents/friction-log/`. Prefer
fewer high-signal cards and one clear contract over aliases, special-cases, or
session noise.

## When to file

File when the pain is **durable**, **recurring**, and has a **clear owner** plus
a **reproducible contract gap** (missing step, lying type, broken harness,
docs/code mismatch). The next agent should be able to act without your session.
A brittle test that was not a great test to begin with counts. File it.

Do **not** file:

- one-off agent confusion or "I don't know the API once"
- overly session-specific nits that will not help the next run
- noise or speculation with no reproducible gap

Filing dedupes for you: a papercut whose title matches an open card adds a "seen
again" note to that card (and raises its priority when yours is higher). Reuse
the same title when you hit the same papercut.

`friction/file` also **soft-skips** (no throw; result lands in `skipped`) when
qualify fails: missing/invalid `target`, no reproducible gap, or
session-bound/transient shape. Treat soft-skip as "do not file," not as a
retry-with-aliases signal.

Fix obvious, low-risk friction in the current change when it is already in
scope. Still mention the fix. File a card only for leftover or out-of-scope
papercuts that still meet the bar above.

## Where it belongs

`friction/file` requires `target: { host: 'github' | 'kody', repo: string }`.
Every target below becomes a card tagged `source:friction` and `kind:friction`.

| Ownership                                                                                | `target`                                   | Card                                                    |
| ---------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| **Platform / this GitHub repo** (docs, harness, worker contracts, contributor tooling)   | `{ host: 'github', repo: 'kody-hq/kody' }` | Card on the `kody` project, tagged `repo:kody-hq/kody`. |
| **Another repo on the factory board**                                                    | `{ host: 'github', repo: 'owner/repo' }`   | Card on that repo's project, tagged `repo:owner/repo`.  |
| **A Kody package** (saved package README, export shape, package job, package-owned docs) | `{ host: 'kody', repo: '@owner/leaf' }`    | Card on the `kody` project, tagged `pkg:@owner/leaf`.   |

## How to fix

For builders, the nightly card run, and in-scope ship-pr fixes:

- Prefer **one clear contract** over aliases, dual call paths, fallbacks, or
  "compat" layers that special-case callers.
- Fix the **real owner** (platform contract or package contract). Do not paper
  over a gap by special-casing a package, caller, or account owner in platform
  code.
- Do not hardcode a specific owner's packages, listings, or identity into
  product surfaces or examples when a neutral example or existing help
  destination works.
- Ship clear durable bugs promptly; record `needs-kent` for items that still
  need a product or ops decision.
- If a proposed fix invents a second way to do the same thing, reject it and fix
  the contract instead (or revert).
- Keep skills and contributing stubs thin; durable API and nightly behavior live
  in the package
  ([Keep agent context lean](../principles/lean-agent-context.md)).

## Card tags

| Tag               | Meaning                                          |
| ----------------- | ------------------------------------------------ |
| `source:friction` | Filed through `friction/file`.                   |
| `kind:friction`   | A papercut (the default `kind: 'general'`).      |
| `repo:owner/repo` | The repo the papercut belongs to.                |
| `pkg:@owner/leaf` | The Kody package the papercut belongs to.        |
| `area:<area>`     | Optional area (`docs`, `cli`, `dev-tooling`, …). |

Optional per-item fields: `priority` (0 to 3), `security: true`, `areas`. P0 and
security friction is routed right away; everything else waits for the nightly
card run.

## File an entry

Run `kody:@kody/kody-factory/friction/file` on Kody cloud (`--context cloud`)
with `target` and `items` (a one-element array is fine):

```bash
npx @kodycodes/cli execute --org kody --context cloud \
  --invoke kody:@kody/kody-factory/friction/file \
  --params '{"target":{"host":"github","repo":"kody-hq/kody"},"items":[{"title":"…","whatHappened":"…","whatYouWanted":"…","howToReproduce":"…","preliminaryInvestigation":"…"}]}'
```

Run it hosted, not with `--local`. Both write the card, but only the hosted run
emits `@kody/factory.card.created`, which drives the card's push and routing.
The local runtime has no `events` binding.

Each filed entry returns its `cardId` and card link (`htmlUrl`). Add
`"dryRun": true` to preview. Fields, soft-skip shapes, and examples live in the
[factory package](https://kody.codes/@kody/kody-factory).

[file-friction](../../.agents/skills/file-friction/SKILL.md) is the short entry
point outside the ship-pr leftover pass. Ship-pr files leftovers before Discord.

## Nightly card run

The factory `friction-daily` job (5:00 AM America/Denver) works the cards filed
during the day. It groups open friction cards per repo and starts one Devin
session per group; package cards go to the package-triage role. Run
`kody:@kody/kody-factory/friction/preview` to see tonight's groups.

Each session puts `Fixes <card link>` in its PR body and finishes with
`kody:@kody/kody-factory/friction/record-outcome`
(`cards: [{ cardId, outcome, note? }]`). The session prompt lists the outcomes;
`needs-kent` parks a card for Kent.
