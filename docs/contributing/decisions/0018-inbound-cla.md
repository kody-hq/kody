# 0018: Inbound CLA for external contributions to this repository

- **Status:** accepted
- **Date:** 2026-08-16

## Context

This repository is Fair Source under [FSL-1.1-ALv2](../../../LICENSE). Copyright
is held by Kent C. Dodds as the sole Licensor. FSL's competing-use restriction,
two-year Apache 2.0 conversion, and any later relicensing or commercial license
only work cleanly when one party can speak as "We" for the whole tree.

GitHub's inbound-same-license rule is not enough here. It licenses a patch under
FSL, but it does not grant relicensing rights, a contributor patent license, or
a warranty that the contributor (or their employer) actually owns the patch. A
Developer Certificate of Origin records provenance only; it does not move those
rights.

The repo is public and has already merged outside human commits, including
substantial UI work. Almost all other history is Kent C. Dodds and allowlisted
automation (Cursor, Kody, Devin, Sentry, Dependabot). Public packages are a
separate catalog surface (authors keep their own copyright; no CLA and no
license gate — see [0043](./0043-repo-visibility-no-community-kind.md)) and are
not this question.

Alternatives considered:

- **Rely on GitHub TOS / implicit FSL inbound.** Fine for same-license use;
  insufficient for relicensing, enforcement, patents, or employer IP.
- **DCO only.** Right tool for Apache/MIT projects; wrong tool for a
  single-licensor Fair Source tree.
- **Copyright assignment.** Heavier than needed; inbound license is enough.
- **Close the repo to outside pull requests.** Legally simplest, but the repo is
  already public and has taken outside patches. Issues and public packages
  remain the preferred place for most work; they do not replace a rule for the
  patches that do land here.

## Decision

Require a signed **inbound Contributor License Agreement** (not assignment)
before merging a pull request that includes commits from anyone other than the
Licensor or an allowlisted bot.

The contributor keeps copyright. They grant Kent C. Dodds a perpetual,
worldwide, irrevocable, sublicensable copyright and patent license, including
the right to relicense the contribution under FSL-1.1-ALv2, Apache 2.0, and any
commercial or other terms the Licensor offers. They represent that they have the
right to grant that license (and employer permission when the work is not theirs
alone).

How it works:

- **Scope.** This git repository only. User packages, catalog listings, and
  unsubmitted forks are out of scope.
- **Who signs.** Every GitHub identity that authors a commit on the pull
  request, unless that identity is `kentcdodds`, `kody-bot`, `cursoragent`, a
  `*[bot]` or `app/*` account, or an email listed as Licensor-owned in
  `cla-signers.json` on the
  [`cla-signatures` branch](https://github.com/kody-hq/kody/blob/cla-signatures/cla-signers.json).
- **Which form.** [Individual CLA](../../legal/individual-cla.md) by default.
  [Entity CLA](../../legal/entity-cla.md) when the work is owned by an employer
  or the contributor is signing for an organization.
- **How they sign.** Read the CLA, then comment on the pull request:
  `I have read the CLA and I hereby sign the CLA` from the identity that needs
  to sign. That exact comment satisfies the `CLA` check for that identity. After
  the pull request merges, the workflow commits the signer to `cla-signers.json`
  on the `cla-signatures` branch. That branch sits outside the `main` ruleset,
  so recording needs no bot pull request or Validate run. Signing covers past,
  present, and future contributions from that identity. Entity CLA recording
  stays a maintainer step.
- **Enforcement.** The `CLA` check job uses `pull_request_target` so
  `GITHUB_TOKEN` can post the signing-instructions comment on fork pull requests
  (plain `pull_request` is read-only for forks). It still checks out only the
  base branch tip, treats PR metadata as untrusted input, and never executes
  pull request head code. The workflow reads signers from the `cla-signatures`
  branch (never from the pull request head), accepts exact signing comments on
  the pull request, fails closed on unsigned identities, and comments with the
  signing steps. The post-merge recorder checks out `main` and the
  `cla-signatures` branch only; it never checks out or runs pull request code.
  Maintainers do not merge a red `CLA` check. There is no trivial-contribution
  exception.
- **Existing commits.** History is not rewritten. People who already contributed
  are asked to sign before the next merge; the CLA text covers prior
  contributions once signed.

## Consequences

- The Licensor stays one party for FSL, the Apache conversion, relicensing, and
  enforcement.
- Individual signatures do not need a maintainer to edit the signers file. The
  post-merge `pull_request_target` recorder commits new signers straight to the
  `cla-signatures` branch; the check reads `cla-signers.json` from its own
  checkout of that branch, separate from the trusted base checkout. It never
  writes `main`. Do not replace that recorder with an unmaintained signing bot
  that writes signer records from untrusted PR head. Using `pull_request_target`
  for the check-and-comment job (base checkout only) is intentional and required
  for fork PRs.
- Public package authors keep their own copyright; they never sign this CLA
  unless they also patch this repository. Listings have no license gate (see
  [0043](./0043-repo-visibility-no-community-kind.md)).
- Revisit if the Licensor becomes a company (assign the inbound grants to that
  successor), if counsel revises the CLA text, or if contribution volume
  justifies hosted click-to-sign.
