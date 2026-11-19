---
id: secret_backed_integration
title: Secret-backed integrations
summary:
  Default non-OAuth recipe for secret-backed integrations: research auth,
  collect secrets through /connect/secret-set, run a smoke test, build the
  downstream package, then surface package secret approval links (prefer
  bulk) before calling the work complete.
category: platform
audience: agents
---

# Secret-backed integrations

Use this guide after `integration_bootstrap` when the integration uses one or
more saved secrets instead of an OAuth integration.

This is the default path for many automation-oriented integrations:

- API keys
- personal access tokens
- account IDs plus tokens
- static credentials that the user can copy from a provider dashboard

## Goal

Keep the integration flow simple:

1. research the provider's auth requirements (see step 1 below)
2. collect the required secret values through `/connect/secret-set`
3. run one real authenticated smoke test
4. only then build the downstream package or workflow

Do **not** jump straight to a package app or saved package if the secret and
smoke-test path is unclear.

## Default recipe

1. Identify the provider's auth contract.
   - When the contract is unfamiliar, read the provider's official docs and
     prefer `communitySearch` for a close helpers package before collecting
     secrets. Verify every URL against the provider's own domain (see
     `integration_bootstrap` for the full trust caveat).
   - Confirm which fields are secrets and which are readable config.
   - Prefer the provider's native credential shape when possible.
   - If the API also needs readable configuration such as an account ID, base
     URL, region, workspace slug, or default sender, store those in memories,
     `packageStorage()`, or a repo — not as secrets.
2. Check whether the needed secrets already exist.
   - Use `search` first for saved secret references.
   - Use `kody.secretList({})` inside `execute` only when you need the current
     runtime metadata.
3. If any secret is missing, stop and send the user to `/connect/secret-set`.
   - Ask for each missing secret by name.
   - Include the provider dashboard URL and short creation steps when helpful.
   - Do **not** ask the user to paste the secret into chat.
4. Wait for the user to confirm the secret is saved.
   - Do not treat the connect URL alone as completion.
5. Run one cheap authenticated smoke test in `execute`.
   - Use the same credential placement and request shape the final package will
     use. In ad hoc code, use the provider slug as the credential key.
   - Prefer a small read-only endpoint such as account info, profile info, or a
     single-item list endpoint.
6. If the smoke test is blocked on host approval, stop.
   - Surface the approval link from the error.
   - Wait for the user to approve the host.
   - Retry only after approval.
7. After the smoke test passes, build the dependent package or workflow.
   - Prefer plain package exports for simple automations.
   - Use a package app only when the user actually needs interactive UI,
     browser-side forms, or hosted callbacks.
8. After the package is saved or published, finish package secret approval when
   needed.
   - Self-authored packages and owner-adopted forks get automatic read/use
     access to user secrets (mutations still need an `allowed_packages` grant);
     unadopted community forks still need explicit package approval for
     read/use, or adoption after review.
   - An ad hoc `execute` smoke test does **not** grant package secret access for
     community forks.
   - Read `pending_secret_package_approvals` from `packageSave` or
     `packagePublishExternalPush` (null for self-authored / adopted packages).
   - When present, either review the source and send the owner the adoption link
     from `communityForkAdopt` (agents cannot adopt), or send
     `bulk_approval_url` / each `approval_url`.
   - Wait for the user to approve or for adoption (when required), then verify
     from `execute` with a static `kody:@scope/package/export` import before
     treating the package as complete. Prefer a read-only export or a
     package-supported dry-run input that actually reads the approved secret
     (for example an authenticated read-only API call), so verification proves
     secret access without external side effects. Secret mounts bind in the
     package's own surfaces (jobs, apps, subscriptions, HTTP invocation).

## Secret names and readable config

Use descriptive names that reflect the real auth contract:

- good secret names:
  - `providerApiKey`
  - `providerAccessToken`
  - `providerAccountToken`
- good places for readable identifiers and defaults (account id, region,
  sender):
  - memories for durable facts the agent should recall
  - `packageStorage()` for package runtime knobs
  - a repo for versioned calibration or documents

If the auth contract has multiple fields, save only the truly sensitive fields
as secrets. Keep readable identifiers and defaults out of the secret store.

## Using a saved Key with scoped fetch

Set the Key's provider and approved host on its credential page. Use
`credential(key).fetch`; the credential decides where its value goes and the
package never reads it. The default Key placement is bearer authorization:

```ts
import { credential } from 'kody:runtime'

const provider = await credential('example')
const response = await provider.fetch('https://api.example.com/v1/me')
```

Use `credentialList` to find metadata and IDs. If several Keys match, pick one
by ID in the execute map. For a saved package, declare a need and have the owner
map it on the package's Credentials tab.

For login or token exchange, use a Login credential. For two protected Basic
auth fields or a secret used as JSON data, use owner-approved request
placements. See [Credentials](./credentials.md#each-kind-through-credential) for
supported kinds and placement rules.

## When `/connect/secret-set` is enough

In the common case, `/connect/secret-set` is the whole setup surface.

Use it when:

- the provider gives the user one or more static secret values
- the final request can use a scoped credential client
- the only extra work after saving the secret is host approval and a smoke test

This should be the default assumption for non-OAuth integrations.

## When to avoid package apps

A package app is **not** the default integration path.

Do **not** build one just to:

- collect a normal API key or token
- collect an account ID or other readable config
- work around the need to ask the user for a secret through
  `/connect/secret-set`

A package app is the exception when the setup requires something
`/connect/secret-set` cannot express cleanly, such as:

- browser-side OAuth or hosted callback handling
- a provider-specific setup wizard with multiple non-secret choices
- a required transformation step that cannot be represented by saving the raw
  secret plus readable config directly

Even then, keep the UI focused on setup. The downstream package should wait for
the post-setup smoke test.

## Recommended chat phrasing

For a new secret-backed integration, the default response shape is:

1. state the auth requirement you found
2. ask the user to save the required secret or secrets through
   `/connect/secret-set`
3. say you will run a smoke test after they confirm setup
4. say you will build the package only after the smoke test passes

Example:

- \"This API uses an account ID plus a token. Please save `providerToken`
  through `/connect/secret-set`. I will keep `providerAccountId` as readable
  config (memory or package storage), run a real authenticated smoke test, and
  then build the package.\"

## Anti-patterns

Avoid these mistakes:

- building a package app before checking whether `/connect/secret-set` is enough
- saving readable config as a secret
- saving the downstream package before the smoke test passes
- assuming a saved secret automatically approves outbound hosts
- treating an ad hoc `execute` smoke test as package secret approval for a
  community-forked package
- marking an unadopted community-forked secret-using package complete without
  sending the adoption link after review (`communityForkAdopt`) or package
  approval links (prefer the bulk approval URL when multiple secrets need
  access)
- inventing a provider-specific flow when one or two secrets plus a smoke test
  would do
