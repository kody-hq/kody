---
id: provider_github
title: Connect GitHub
summary:
  Verified walkthrough for connecting GitHub to Kody: fine-grained personal
  access tokens, bring-your-own OAuth Apps, scope choices, prefilled connect
  links, and copy-paste smoke tests.
category: provider
provider: GitHub
lastVerified: 2026-08
---

# Connect GitHub

GitHub has two good lanes:

- **Personal access token** — fastest for many automations; saved as a Kody
  secret (and what `@kody/github` reads by default).
- **Bring-your-own OAuth App** — when you want a durable OAuth connection with
  your own client and rate limits.

## What you get

Once connected, you can ask Kody things like:

- "List my open pull requests and summarize the review comments."
- "Create an issue in my dotfiles repo about the flaky bootstrap script."
- "What merged in acme/api this week?"

## Before you start

- Personal accounts are free; no review process applies to these lanes.
- If you need repositories in an organization with OAuth App access
  restrictions, an org owner must approve the OAuth App before it can see org
  data. Fine-grained tokens have their own per-org approval flow for org-owned
  repositories.
- The API rate limit is 5,000 requests per hour per authenticated user.

Open the next heading when you reach that step.
`search({ entity: "guide:provider_github#create-a-token" })`, then
`#save-the-token`, then `#confirm-the-call`. Pull-request readiness is
`#pull-request-readiness` once the call succeeds.

## Create a token

Open
[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
(fine-grained). Classic tokens at
[github.com/settings/tokens/new](https://github.com/settings/tokens/new) also
work and grant coarser access.

On that page:

1. Name the token.
2. Set **Expiration** to the date GitHub offers that matches how long you want
   the token. 90 days is the usual fine-grained choice. That date lives at
   GitHub. Kody’s Expires field is separate and comes on the next step.
3. Choose **Only select repositories** (or all repositories).
4. Pick the repository permissions this task needs. Reporting starts with
   **Contents: Read-only** and **Pull requests: Read-only**. A readiness check
   also wants **Checks: Read-only** and **Commit statuses: Read-only** — see
   [Pull request readiness](#pull-request-readiness). Add write permissions when
   the automation mutates.
5. Generate the token and copy it once.

When the token is copied, open
`search({ entity: "guide:provider_github#save-the-token" })`.

## Save the token

Send this page. The person pastes the token into **Secret value**:

```text
https://kody.codes/connect/secret-set?name=githubAccessToken&description=GitHub%20fine-grained%20personal%20access%20token&allowedHosts=api.github.com&scope=user
```

**Expires** on that page is optional. Leave it empty and Kody keeps the secret
until they delete it. That cutoff is Kody’s, separate from the expiration they
already set at GitHub. Fill it only when they want Kody to stop sending the
token on a chosen date.

The link already lists `api.github.com` under **Where this secret can be sent**.
Saving stores the token and that host. The name `githubAccessToken` is what
`@kody/github` (and a fork of it) reads by default.

When they confirm the save, open
`search({ entity: "guide:provider_github#confirm-the-call" })`.

## Confirm the call

Run this in `execute`:

```ts
export default async function main() {
	const response = await fetch('https://api.github.com/user', {
		headers: {
			Accept: 'application/vnd.github+json',
			Authorization: 'Bearer {{secret:githubAccessToken}}',
			'X-GitHub-Api-Version': '2022-11-28',
		},
	})
	if (!response.ok) {
		throw new Error(
			`GitHub smoke test failed: ${response.status} ${await response.text()}`,
		)
	}
	const user = (await response.json()) as { login: string }
	return { login: user.login }
}
```

A login in the result means the secret and `api.github.com` line up. When the
error says the host is not approved, open
`/connect/secrets?name=githubAccessToken&hosts=api.github.com` and run the call
again after they approve it.

## Pull request readiness

Open this section when writing a readiness package, after the call above
succeeds.

The pull request page shows one combined list. That list is two APIs plus the
pull request itself:

- **Check runs** — `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`
  ([list check runs](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)).
  Fine-grained permission: **Checks: Read-only**.
- **Commit statuses** — `GET /repos/{owner}/{repo}/commits/{ref}/status`
  ([combined status](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference)).
  Fine-grained permission: **Commit statuses: Read-only**.
- **Reviews** and the pull request **`mergeable`** field, from the pull request
  API. Fine-grained permission: **Pull requests: Read-only**.

Read check runs and the combined commit status. A green check-run list can sit
next to a failing commit status, and the reverse. `mergeable` is its own field
on the pull request.

## Bring-your-own OAuth App

1. Open [github.com/settings/developers](https://github.com/settings/developers)
   -> **OAuth Apps** -> **New OAuth App**.
2. Fill in the application name and homepage URL, and set the **Authorization
   callback URL** to `https://kody.codes/connect/oauth` (OAuth Apps accept one
   callback URL; a self-hosted deployment registers its own origin plus
   `/connect/oauth`).
3. After creating the app, click **Generate a new client secret** and copy the
   client ID and secret.

GitHub supports S256 PKCE and recommends it. The client secret stays required at
the token endpoint, so the Kody flow is `confidential`. OAuth App tokens have no
scheduled expiry and there are no refresh tokens, but GitHub revokes a token
after a year without use; revoke the grant from GitHub settings to kill one
sooner. Kody sees no refresh token and no expiry at connect, records the
connection as non-expiring, and does not ask you to reconnect for a missing
refresh token. If you later turn on token expiration for the app, reconnect so
Kody picks up the refresh token.

### Connect to Kody

```text
https://kody.codes/connect/oauth?provider=github&authorizeUrl=https%3A%2F%2Fgithub.com%2Flogin%2Foauth%2Fauthorize&tokenUrl=https%3A%2F%2Fgithub.com%2Flogin%2Foauth%2Faccess_token&flow=confidential&scopes=read%3Auser%20notifications&allowedHosts=api.github.com
```

For a team organization, add `&org=<team-slug>` so the app and connection are
saved there; without it they go to the personal organization (see
`guide:oauth`).

Decoded: authorize URL `https://github.com/login/oauth/authorize`, token URL
`https://github.com/login/oauth/access_token`, `flow=confidential`, scopes
`read:user notifications` (space-separated; adjust per the Scopes section), and
`allowedHosts=api.github.com`. Add `pkce=true` to layer S256 PKCE on top of the
confidential exchange. Paste the client ID and secret into the setup form, then
authorize.

## Verify

Saved secret: [Confirm the call](#confirm-the-call).

OAuth integration:

```ts
import { createAuthenticatedFetch } from 'kody:runtime'

export default async function main() {
	const githubFetch = await createAuthenticatedFetch('github')
	const response = await githubFetch('https://api.github.com/user', {
		headers: { Accept: 'application/vnd.github+json' },
	})
	if (!response.ok) {
		throw new Error(
			`GitHub smoke test failed: ${response.status} ${await response.text()}`,
		)
	}
	const user = (await response.json()) as { login: string }
	return { login: user.login }
}
```

## Scopes

OAuth App scopes are space-delimited and coarse:

- Minimal read-mostly tier: `read:user`, `user:email`, `notifications`,
  `public_repo` (public repositories only), `read:org`.
- Fuller tier: `repo` grants full read/write on private repositories — there is
  no read-only scope for private repos, so requesting private access means
  accepting write access too. Add `gist` for gists.

Fine-grained tokens are the better tool when you want read-only access to
private repositories: their permissions are per-repository and per-capability.

## Troubleshooting

- `The redirect_uri MUST match the registered callback URL`: the callback must
  be exactly `https://kody.codes/connect/oauth`.
- Organization repositories missing from results: the org restricts OAuth App
  access. Request approval under the org's third-party access settings, or use a
  fine-grained token approved for that org.
- `401 Bad credentials` with a saved token: the token expired or its value has a
  stray space. Rotate it at the token settings page and update the secret.
- `403` with `X-RateLimit-Remaining: 0`: the 5,000 req/hr per-user limit. Wait
  for the reset or batch queries with the GraphQL API.
- Token exchange fails on the OAuth lane: the client secret is required even
  with PKCE. Regenerate the secret and reconnect.

## Use the `@kody/github` package and verify

A saved token or integration is credentials only. Finish by forking the
`@kody/github` helpers so day-to-day work goes through maintained code in
**your** org instead of hand-rolled API calls. `@kody/github` is a public
community package from the `@kody` org.

1. Search for `@kody/github`. It wraps REST, GraphQL, pagination, and PR
   helpers.
2. `communityFork` it into your org (or click **Install** on the listing).
3. Check the fork's README **Required setup**: the default `bot` account reads
   the `githubAccessToken` secret — the exact name
   [Save the token](#save-the-token) uses, so no adaptation is needed for the
   saved token. For OAuth, remap the account to the `github` integration name
   when the package supports that.
4. Verify the fork against your credentials from `execute`:

```ts
import getViewer from 'kody:@<your-username>/github/get-viewer'

export default async function main() {
	return getViewer({ account: 'bot' })
}
```

A successful response returns the GitHub login your token resolves to — proving
the fork, the secret, and `api.github.com` all line up.
