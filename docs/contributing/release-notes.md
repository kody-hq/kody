# Release notes

Product-facing release notes for this repository live in **pull request bodies**
and the Discord ship summary (`@kentcdodds/ship-pr/send-summary`), not in a repo
`CHANGELOG`. Durable docs describe current behavior; they are not a changelog
([documentation principles](./documentation.md)).

## PR body

Use
[`.github/pull_request_template.md`](../../.github/pull_request_template.md).
When a change can break existing published packages or saved credentials at
runtime, add a short **`### May break packages`** section under Summary:

- What breaks (one or two sentences).
- Who is affected (prefer **counts**: packages, runs, credentials — not public
  handles, package names, IDs, or emails).
- How to fix (link a guide when one exists).

Omit the heading when nothing breaks at runtime.

## Backfill: path-segment credential encoding (#3408 / #3425)

**May break packages.** Since production 2026-10-11 (#3408, restored by #3425),
a credential filled into a URL path is encoded as **one path segment**. A `/`,
`?`, or `#` in the secret becomes `%2F` / `%3F` / `%23` and cannot change the
route. Packages that stored a whole webhook path (for example Slack/Discord
`/services/…/…/…`) in one secret and placed it in the path started getting
remote 4xx with little explanation. Prefer a literal path prefix plus a
one-segment secret; see
[Placeholders in fetch](../use/secrets-and-values.md#placeholders-in-fetch). A
later change adds a 4xx run-log / response warning that names the credential
(never its value).
