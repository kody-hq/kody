# Friction log

Contributor and agent papercuts while working in this repository live as GitHub
issues labeled `friction`. They are not files in the tree.

This is not [platform friction](../guides/platform-friction.md). That guide is
for user-facing Kody product feedback. This page is for developing the
`kody-hq/kody` repo: confusing docs, a test that only fails locally, a command
that needs a secret handshake, a type that lies.

This page is the policy for humans and agents: when to file, where it belongs,
and how to judge fixes. The filing API and qualify rules live in
[@kody/kody-factory](https://kody.codes/@kody/kody-factory) (`friction/file`).
The daily sweep and its operator controls live in
[@kentcdodds/friction-log](https://kody.codes/@kentcdodds/friction-log). Do not
write entries under `.agents/friction-log/`. Prefer fewer high-signal issues and
one clear contract over aliases, special-cases, or session noise.

## When to file

File when the pain is **durable**, **recurring**, and has a **clear owner** plus
a **reproducible contract gap** (missing step, lying type, broken harness,
docs/code mismatch). The next agent should be able to act without your session.
A brittle test that was not a great test to begin with counts — file it.

Do **not** file:

- one-off agent confusion or "I don't know the API once"
- overly session-specific nits that will not help the next run
- noise or speculation with no reproducible gap

Search open `friction` issues first (`gh issue list --label friction` or
`kody:@kentcdodds/friction-log/scan`). Comment on a match instead of opening a
duplicate.

`friction/file` also **soft-skips** (no throw; result lands in `skipped`) when
qualify fails: missing/invalid `target`, no reproducible gap, or
session-bound/transient shape. Treat soft-skip as "do not file," not as a
retry-with-aliases signal.

Fix obvious, low-risk friction in the current change when it is already in
scope. Still mention the fix. File an issue only for leftover or out-of-scope
papercuts that still meet the bar above.

## Where it belongs

`friction/file` requires `target: { host: 'github' | 'kody', repo: string }`.

| Ownership                                                                                | `target`                                                                                                     | Route                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **Platform / this GitHub repo** (docs, harness, worker contracts, contributor tooling)   | `{ host: 'github', repo: 'kody-hq/kody' }`                                                                   | GitHub `friction` issue on that repo (never raw `gh issue create` or a raw GitHub issues POST). |
| **Another GitHub repo** with its own friction label workflow                             | `{ host: 'github', repo: 'owner/repo' }`                                                                     | GitHub `friction` issue on that `owner/repo`.                                                   |
| **A Kody package** (saved package README, export shape, package job, package-owned docs) | `{ host: 'kody', repo: '@owner/leaf' }` (or the package's kody id / identity string the live export accepts) | Wakes **Patch** via grok-bot. No GitHub issue.                                                  |

## How to fix

For builders, the daily sweep, and in-scope ship-pr fixes:

- Prefer **one clear contract** over aliases, dual call paths, fallbacks, or
  "compat" layers that special-case callers.
- Fix the **real owner** (platform contract or package contract). Do not paper
  over a gap by special-casing a package, caller, or account owner in platform
  code.
- Do not hardcode a specific owner's packages, listings, or identity into
  product surfaces or examples when a neutral example or existing help
  destination works.
- Ship clear durable bugs promptly; park (skip / `friction-skipped`) items that
  still need a product or ops decision.
- If a proposed fix invents a second way to do the same thing, reject it and fix
  the contract instead (or revert).
- Keep skills and contributing stubs thin; durable API and daily behavior live
  in the package
  ([Keep agent context lean](../principles/lean-agent-context.md)).

## Labels

| Label              | Purpose                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `friction`         | Marks a repo papercut. Applied by the issue form, `create`, and `file`. |
| `friction-skipped` | Daily sweep will not re-investigate until this label is removed.        |

This repository does not define labels in-tree (no `.github/labels.yml`). Create
or update them with the GitHub API or `gh label create` / `gh label edit`. The
live `friction-skipped` label description should match the table above.

## File an entry

Humans can use the
[Friction issue form](../../.github/ISSUE_TEMPLATE/friction.yml), which applies
the `friction` label.

Agents file leftovers through `kody:@kody/kody-factory/friction/file` (run with
`--org kody`; `target` + `items`, including a one-element array) via
prefer-local CLI execute
([prefer-local-cli-execute](../../.agents/skills/prefer-local-cli-execute/SKILL.md)).
It opens the same labeled GitHub issue (or Patch wake) as the old export. If the
factory export errors, use the old `kody:@kentcdodds/friction-log/file` (run
without `--org kody`) with the same params. If `--local` cannot run, fix the
environment so local works. Open API / MCP `api` cannot invoke this package
export, and hosted MCP `execute` is banned. Always pass `target`. Contract,
fields, soft-skip shapes, and examples live in the
[factory package](https://kody.codes/@kody/kody-factory).

[file-friction](../../.agents/skills/file-friction/SKILL.md) is the short entry
point outside the ship-pr leftover pass. Ship-pr files leftovers before Discord.

Do not use `gh issue create` or `kody:@kentcdodds/github/request` POST to
`/repos/kody-hq/kody/issues`. Those paths can omit the `friction` label, so the
daily sweep never sees the issue.

## Daily sweep

`@kentcdodds/friction-log` runs the daily job. Daily sweep eligibility is:
open + `friction` + NOT `friction-skipped`. Eligibility does not scrape issue
comments. When any issues are eligible, the package may spawn one Cursor Cloud
Agent on `kody-hq/kody` `main`.

Daily agent instructions (outcomes, skip/unskip, record-outcome) come from the
package when spawned (`agent-prompt` and package `AGENTS.md`). On skip, apply
the GitHub label `friction-skipped`. Unskip by removing `friction-skipped`. When
acting on a Kent reply after a skip, remove `friction-skipped` if present.

Package imports for operators and agents:
[https://kody.codes/@kentcdodds/friction-log](https://kody.codes/@kentcdodds/friction-log).
