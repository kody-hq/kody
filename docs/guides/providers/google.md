---
id: provider_google
title: Connect Google (Gmail, Calendar, Drive)
summary:
  Verified walkthrough for connecting Google to Kody: bring-your-own OAuth
  client, Google Auth Platform console steps, the Testing-status 7-day
  refresh-token trap, and a Calendar or Gmail smoke test.
category: provider
provider: Google
lastVerified: 2026-08
---

# Connect Google (Gmail, Calendar, Drive)

Connect Google by creating your own OAuth client in Google Cloud. Register
Kody's redirect URI, then finish on `/connect/oauth`. Inbox reading and
Drive-wide access need those scopes on the client you own.

For a teaching walkthrough of Gmail inbox reading as an interactive agent
transcript, see [google-oauth.md](../google-oauth.md).

For drafts the agent must not send, watch
[Make your agent safe and autonomous](https://www.youtube.com/watch?v=_EJTrJFLa3g).
The written version is [Gmail drafts without send](../locked-gmail-drafts.md).

## What you get

Once connected, you can ask Kody things like:

- "What is on my calendar tomorrow?" or "Summarize this week's meetings."
- "Send this status update to the billing alias." (`gmail.send`)
- "Check my inbox for the invoice from Acme and summarize it."
  (`gmail.readonly`)
- "Find the latest budget spreadsheet in my Drive." (Drive-wide access)

## Before you start

- You need a Google account and access to
  [Google Cloud console](https://console.cloud.google.com). A free account is
  enough; a personal OAuth client costs nothing.
- The OAuth settings live under **APIs & Services -> Google Auth Platform**
  (with **Branding**, **Audience**, **Clients**, and **Data Access** tabs).
  Older tutorials that navigate to an "OAuth consent screen" menu item are
  stale; the same settings live in Google Auth Platform.
- Gmail read scopes are "restricted" in Google's verification program. That is
  fine for a personal (unverified) app; see the Scopes section before choosing.

## Create the OAuth client

1. Open [console.cloud.google.com](https://console.cloud.google.com) and create
   or select a project.
2. In **APIs & Services -> Library**, enable each API you plan to use: **Google
   Calendar API**, **Gmail API**, and/or **Google Drive API**.
3. Open **APIs & Services -> Google Auth Platform** and click **Get started**.
   The wizard asks for app **Branding** (name, support email), **Audience**
   (choose **External**), and contact information.
4. On the **Clients** tab, click **Create Client**, choose application type
   **Web application**, and add the redirect URI
   `https://kody.codes/connect/oauth` (exact match; a self-hosted deployment
   registers its own origin plus `/connect/oauth`).
5. Copy the **client ID** and **client secret** shown after creation.
6. On the **Data Access** tab, add the scopes you plan to request (see the
   Scopes section).
7. While the app's publishing status is **Testing**, add your own Google account
   as a test user on the **Audience** tab.

### Publish to Production (avoid the 7-day trap)

Apps with publishing status **Testing** get refresh tokens that expire after
seven days. Everything works during setup, then the integration silently dies a
week later with `invalid_grant` errors on refresh.

Fix: on the **Audience** page, click **Publish app** to move the app to
**Production**. Google shows an "unverified app" warning during consent — click
**Advanced -> Go to <app name> (unsafe)** and continue. For a personal app this
is expected: the unverified-app cap of 100 users is irrelevant when you are the
only user, and full verification (which restricted Gmail scopes would require,
including an annual CASA security assessment) only matters for apps distributed
to the public.

### Connect to Kody

Open a prefilled connect link while signed in to Kody. Google is a confidential
client (the client secret is sent form-encoded to the token endpoint), and
`access_type=offline` plus `prompt=consent` make sure a refresh token is issued:

```text
https://kody.codes/connect/oauth?provider=google&authorizeUrl=https%3A%2F%2Faccounts.google.com%2Fo%2Foauth2%2Fv2%2Fauth&tokenUrl=https%3A%2F%2Foauth2.googleapis.com%2Ftoken&flow=confidential&scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.readonly&allowedHosts=www.googleapis.com&extraAuthorizeParams=%7B%22access_type%22%3A%22offline%22%2C%22prompt%22%3A%22consent%22%7D
```

For a team organization, add `&org=<team-slug>` so the app and connection are
saved there; without it they go to the personal organization (see
`guide:oauth`).

Decoded, that is authorize URL `https://accounts.google.com/o/oauth2/v2/auth`,
token URL `https://oauth2.googleapis.com/token`, `flow=confidential`, the
`calendar.readonly` scope, `allowedHosts=www.googleapis.com`, and
`extraAuthorizeParams={"access_type":"offline","prompt":"consent"}`. To add
Gmail read, append `https://www.googleapis.com/auth/gmail.readonly` to `scopes`
(space-separated) and add `gmail.googleapis.com` to `allowedHosts`. Paste the
client ID and client secret into the setup form on that page, then authorize.

Google only returns a refresh token on the first consent for a given client;
`prompt=consent` forces a fresh grant so reconnects also get one.

## Verify

Run this smoke test in `execute` after connecting (adjust the integration name
if you chose something other than `google`):

```ts
import { createAuthenticatedFetch } from 'kody:runtime'

export default async function main() {
	const googleFetch = await createAuthenticatedFetch('google')
	const response = await googleFetch(
		'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=3',
	)
	if (!response.ok) {
		throw new Error(
			`Calendar smoke test failed: ${response.status} ${await response.text()}`,
		)
	}
	const data = (await response.json()) as {
		items?: Array<{ summary?: string }>
	}
	return { calendars: data.items?.map((item) => item.summary) }
}
```

For a Gmail-scoped connection, swap the URL for
`https://gmail.googleapis.com/gmail/v1/users/me/profile` (and make sure
`gmail.googleapis.com` is in the connection's allowed hosts).

## Scopes

Start minimal and widen only when a task needs it:

- Minimal read-mostly tier: `https://www.googleapis.com/auth/calendar.readonly`
  (or the narrower `calendar.events.readonly`),
  `https://www.googleapis.com/auth/drive.readonly`. These are "sensitive"
  scopes; verification only matters for public apps.
- Gmail read: `https://www.googleapis.com/auth/gmail.readonly`. Every Gmail read
  scope, including `gmail.metadata`, is "restricted" — public apps would need
  full Google verification with an annual CASA security assessment, which is why
  this setup stays a personal unverified app.
- Send-only: `https://www.googleapis.com/auth/gmail.send` is sensitive rather
  than restricted, so an app that only sends mail avoids the restricted tier.
- Drafts: Google has no drafts-only scope.
  [`gmail.compose`](https://developers.google.com/workspace/gmail/api/auth/scopes)
  is restricted and "Manage drafts and send emails." Creating a draft requires
  that grant (or a wider write scope). Publish a drafts-only package and lock it
  so the token cannot grow into send — see
  [locked-gmail-drafts.md](../locked-gmail-drafts.md).
- Fuller tier: read-write Calendar (`.../auth/calendar`) or Drive
  (`.../auth/drive`) let Kody create events and files, at the cost of a much
  bigger blast radius if misused.

Changing scopes means reconnecting: update the **Data Access** tab, then open
`/connect/oauth?provider=<your-integration-name>` with the new `scopes` value
(the default name in this guide is `google`).

## Troubleshooting

- `redirect_uri_mismatch` during consent: the registered redirect URI must be
  exactly `https://kody.codes/connect/oauth` — no trailing slash, no `www`.
- Integration works for a week, then fails with `invalid_grant`: the app is in
  **Testing** publishing status. Publish it to Production and reconnect.
- No refresh token saved: Google only returns one on first consent. Reconnect
  with `prompt=consent` in `extraAuthorizeParams` (the prefilled link includes
  it).
- `403 accessNotConfigured` or "API has not been used in project": enable the
  Calendar/Gmail/Drive API in the project's API Library.
- "Google hasn't verified this app" interstitial: expected for a personal app.
  Click **Advanced** and continue.
- `403` from Gmail with a Calendar-only token: scopes are per-connection.
  Reconnect with the needed Gmail scope.

## Use the `@kody/google` package and verify

A saved integration is auth credentials only. Finish by forking `@kody/google`,
a public community package from the `@kody` org, so day-to-day work goes through
maintained Gmail, Calendar, and Drive helpers in **your** org instead of raw
`createAuthenticatedFetch` calls.

1. Search for `@kody/google`. It covers Gmail, Calendar, Drive, People, and
   YouTube.
2. `communityFork` it into your org (or click **Install** on the listing).
3. Check the fork's README **Required setup**: the `personal` account alias maps
   to an integration named `google` — the default name this guide's connect link
   uses, so the primary lane needs no adaptation.
4. Verify the fork against your integration from `execute`:

```ts
import { smokeTest } from 'kody:@<your-username>/google'

export default async function main() {
	return smokeTest({ account: 'personal' })
}
```

A successful response returns the Google profile your integration resolves to —
proving the fork, the OAuth tokens, and the host approvals all line up.
