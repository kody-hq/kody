---
id: provider_spotify
title: Connect Spotify
summary:
  Verified walkthrough for connecting Spotify to Kody: dashboard app
  creation, the Development Mode Premium requirement and endpoint limits in
  force since February 2026, the PKCE public-client connect link, listening
  and playback scopes, and a profile smoke test.
category: provider
provider: Spotify
lastVerified: 2026-08
---

# Connect Spotify

Spotify uses a personal app created in its developer dashboard, connected to
Kody with the authorization code + PKCE flow. PKCE is a public-client flow, so
no client secret needs to be stored.

## What you get

Once connected, you can ask Kody things like:

- "What did I listen to this morning?"
- "Add the current track to my liked songs playlist."
- "Build a report of my top artists this month."

## Before you start

Read the costs section first — Spotify's Development Mode has real
prerequisites.

### Costs and limits

- Since February 2026, Development Mode requires the app owner to hold Spotify
  Premium. If Premium lapses, the app stops working until it is restored.
- Developers can create up to 25 client IDs (raised from 1 in July 2026); all of
  a developer's Development Mode apps share one API quota budget.
- Refresh tokens expire six months after the user's original authorization
  (refreshing an access token does not extend this), so plan on reconnecting
  about twice a year; see Troubleshooting.
- Some Web API endpoints are unavailable in Development Mode; see the
  [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
  for the endpoint list.
- Extended Quota Mode is only available to organizations with at least 250k
  monthly active users — not a realistic path for individuals. Personal use
  stays in Development Mode, which is fine for one user: the app owner can
  always authorize their own app.

## Create the app

1. Open the
   [Spotify developer dashboard](https://developer.spotify.com/dashboard) and
   click **Create app**.
2. Fill in the app name and description, set the redirect URI to
   `https://kody.codes/connect/oauth`, select **Web API** under the APIs used,
   and accept the developer terms. Spotify requires HTTPS redirect URIs and does
   not accept `localhost`, so use the hosted Kody URI (a self-hosted deployment
   registers its own HTTPS origin plus `/connect/oauth`). Matching is exact.
3. Copy the **client ID** from the app page. With PKCE you do not need the
   client secret (it lives under **Settings** if you ever choose the
   confidential flow instead).
4. Only if someone other than the app owner will authorize: add their Spotify
   account under **User Management** (Development Mode allows up to 5 users).
   For personal use this step is unnecessary.

## Connect to Kody

`flow=pkce` is Kody's default, so the link needs no flow parameter and no client
secret:

```text
https://kody.codes/connect/oauth?provider=spotify&authorizeUrl=https%3A%2F%2Faccounts.spotify.com%2Fauthorize&tokenUrl=https%3A%2F%2Faccounts.spotify.com%2Fapi%2Ftoken&scopes=user-read-recently-played%20user-read-playback-state%20user-library-read&allowedHosts=api.spotify.com
```

For a team organization, add `&org=<team-slug>` so the app and connection are
saved there; without it they go to the personal organization (see
`guide:oauth`).

Decoded: authorize URL `https://accounts.spotify.com/authorize`, token URL
`https://accounts.spotify.com/api/token`, scopes
`user-read-recently-played user-read-playback-state user-library-read`
(space-separated; adjust per the Scopes section), and
`allowedHosts=api.spotify.com`. Paste the client ID into the setup form, then
authorize.

Access tokens last one hour. Refresh responses may rotate the refresh token or
omit it (keep using the existing one when omitted) — Kody's token refresh
handles both cases automatically. Refresh tokens hard-expire six months after
the original authorization regardless of use.

## Verify

Run this smoke test in `execute` after connecting:

```ts
import { createAuthenticatedFetch } from 'kody:runtime'

export default async function main() {
	const spotifyFetch = await createAuthenticatedFetch('spotify')
	const response = await spotifyFetch('https://api.spotify.com/v1/me')
	if (!response.ok) {
		throw new Error(
			`Spotify smoke test failed: ${response.status} ${await response.text()}`,
		)
	}
	const me = (await response.json()) as { display_name?: string; id: string }
	return { id: me.id, displayName: me.display_name }
}
```

## Scopes

Space-delimited. Start with the read tier:

- Minimal read-mostly tier: `user-read-recently-played`,
  `user-read-playback-state`, `user-read-currently-playing`,
  `user-library-read`, `playlist-read-private`, `user-top-read`. These cover
  listening history, current playback, saved tracks, private playlists, and top
  artists/tracks.
- Fuller tier: add `user-modify-playback-state` to control playback (play,
  pause, skip, queue). Playback control acts on your real devices, so only add
  it when you actually want Kody driving the speakers.

Changing scopes means reconnecting: `/connect/oauth?provider=spotify` with a new
`scopes` value re-runs consent.

## Troubleshooting

- `INVALID_CLIENT: Invalid redirect URI`: the dashboard redirect URI must be
  exactly `https://kody.codes/connect/oauth`. Spotify rejects `localhost` and
  any non-HTTPS URI.
- `403 User not registered in the Developer Dashboard`: someone other than the
  app owner tried to authorize a Development Mode app. Add them under **User
  Management** (max 5) or have them create their own app.
- `403` on a specific endpoint that works elsewhere: that endpoint may be
  unavailable in Development Mode; check the February 2026 migration guide.
- App suddenly failing across the board: check that the app owner's Premium
  subscription is active — Development Mode requires it.
- `401` after roughly an hour in a long-running script: access tokens expire
  hourly. Use `createAuthenticatedFetch`, which refreshes automatically, instead
  of caching a raw token.
- `invalid_grant` on refresh about six months after connecting: the refresh
  token reached its six-month lifetime (measured from the original
  authorization, not the last refresh). Reconnect at
  `/connect/oauth?provider=spotify` to start a fresh six-month window.

## Use a helper package and verify

A saved integration is auth credentials only. Finish by putting maintained
helpers in front of it. There is no `@kody/spotify` package, so this path uses
another person's public package. Review the source, then fork it.

1. Find the package with `communitySearch({ query: 'spotify' })` — the
   `@kentcdodds/spotify` package wraps playback, playlists, search, library, and
   devices. It is not admin-trusted, so review the forked source before
   publishing (forks land inert until you publish them).
2. Fork it with `communityFork` (or click **Install** on the package page).
3. Check the fork's README **Required setup**: the default account maps to an
   integration named `spotify` — the name this guide's connect link uses, so the
   primary lane works as-is. Remove the `spotify-family` second-account wiring
   unless you have one.
4. Verify the package against your integration from `execute` with a read-only
   helper, for example a library or search export, and confirm it returns your
   data. Playback helpers additionally need an active Spotify device.

That closes the loop: credentials connected, smoke-tested raw, and exercised
through the package your automations will actually call.
