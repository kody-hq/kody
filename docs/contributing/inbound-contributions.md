# Inbound contributions

How outside patches enter [this repository](https://github.com/kody-hq/kody).
The decision and the why live in
[0018 — Inbound CLA](./decisions/0018-inbound-cla.md).

This page is the platform-repo contribution path. Most reusable behavior belongs
in a [public package](../use/community-packages.md). You do not sign a CLA to
publish or fork a catalog listing.

## What needs a CLA

A pull request needs a signed Contributor License Agreement when any commit on
it is authored by someone other than Kent C. Dodds or an allowlisted bot.

The contributor keeps copyright. The CLA is an inbound license so the repository
can stay a single-licensor Fair Source tree under [FSL-1.1-ALv2](../../LICENSE).

Sign the [Individual CLA](../legal/individual-cla.md) unless an employer owns
the work. If an organization owns the work, an authorized representative
completes the [Entity CLA](../legal/entity-cla.md) instead.

There is no exception for docs-only or one-line patches.

## How to sign (individual)

1. Open the pull request.
2. Read the [Individual CLA](../legal/individual-cla.md).
3. Comment exactly:

   ```
   I have read the CLA and I hereby sign the CLA
   ```

4. The exact phrase, allowing surrounding whitespace, satisfies the `CLA` check
   only when posted by the pull request author or a commit author on that pull
   request. A bystander's comment does not sign for another contributor.

The check runs on `pull_request_target` so fork pull requests can receive the
unsigned-instructions comment (`pull_request` is read-only for forks). The job
still checks out only the base branch tip and never runs pull request head code.
See [0018 — Inbound CLA](./decisions/0018-inbound-cla.md).

Signing once covers past, present, and future contributions from that GitHub
identity. Unsigned prior contributors sign the same way before their next merge.
The workflow reads existing signers from `main`, not from the pull request
branch, so adding your own username on the branch does not pass the check. Only
the GitHub identity that posted the exact signing comment is treated as signed.

After a pull request merges, the recorder scans it and the most recent 50 merged
pull requests, so a replaced or missed run is healed by a later run. A
maintainer can also start the recorder manually with `workflow_dispatch`. New
signers are recorded by a bot pull request on the fixed `cla/record-signers`
branch. It merges only after `✅ Validate` succeeds for the exact head SHA that
was validated.

## How to sign (entity)

An authorized representative emails
[me@kentcdodds.com](mailto:me@kentcdodds.com) with:

- subject `Kody Entity CLA`
- legal name and address of the organization
- representative name and title
- GitHub usernames authorized to submit on the organization's behalf
- a statement that the organization accepts the
  [Entity CLA](../legal/entity-cla.md)

Licensor records those usernames after accepting the agreement.

## Who does not sign

These identities are allowlisted in `.github/cla-signers.json` and do not sign:

- `kentcdodds` (Licensor)
- `kody-bot` and other logins listed in that file
- `cursoragent` (Cursor Cloud Agent commit author)
- Licensor-owned commit emails listed in that file
- GitHub accounts whose login ends in `[bot]` or starts with `app/`

Cursor Cloud Agent pull requests follow the Licensor path even when GitHub
authors the pull request as `kentcdodds` and the commits as `cursoragent`.

## Maintainer steps

Do not merge a pull request while the `CLA` check is red.

Individual signatures are recorded automatically after merge through the
`cla/record-signers` bot pull request. The recorder self-heals over the most
recent 50 merged pull requests and can be started manually with
`workflow_dispatch`; the signer PR merges only when `✅ Validate` succeeds on
the exact validated head SHA. After an accepted Entity CLA, add each authorized
username to `.github/cla-signers.json` on `main` with `signedAt` as an ISO date
(`YYYY-MM-DD`) and `cla` of `entity`.

Make the `CLA` check required for `main` in GitHub branch protection so a green
review cannot skip it.

## Out of scope

- Publishing or forking public packages
- Issues, discussions, and security reports that do not include a patch
- Private vulnerability reports ([Security policy](../../SECURITY.md))
