# Social login (Sign in with GitHub / Google / X / Discord)

Kody supports social login as an OAuth 2.0 **client** of GitHub, Google, X, and
Discord. This is a third OAuth subsystem, deliberately separate from the other
two:

- Kody-as-provider MCP OAuth (`/oauth/authorize`, `/oauth/callback`)
- Outbound integration OAuth for connecting third-party APIs (`/connect/oauth`)

Provider identities are stored in the `oauth_connections` D1 table
(`provider_name` + `provider_id` → `user_id`). No provider access tokens are
persisted; the token is used once per login to fetch the profile.

## How the flow behaves

Routes and Start functions (see
`packages/worker/src/app/handlers/auth-provider.ts`,
`packages/worker/start/server/auth-mutations.ts`, and
`packages/worker/start/pages/account-connections-panel.tsx`):

- Enabled providers: `/login`, `/signup`, and `/oauth/authorize` embed
  `publicAuthProvidersLoaderData` during SSR so the buttons are in the first
  HTML. SPA navigations load the same payload with `readWebsiteAuthProviders`. A
  provider only appears when both its client id and secret env vars are set.
- `startWebsiteOAuth` — starts the flow (signed `kody_oauth_login` state cookie
  with CSRF state + PKCE verifier) and returns `{ authorizeUrl }` for
  client-side navigation.
- `GET /auth/:provider/callback` — completes the flow
- `GET /discord` — public Discord page (**Connect Discord** joins the official
  server and links the account; signed-in visitors see whether
  `oauth_connections` already has Discord)
- `/account` — signed-in connection management (list, disconnect via
  `disconnectAccountProvider`)

The first-party UI always starts OAuth this way: the CSP locks `form-action` and
`connect-src` to `'self'`, so neither a form-POST redirect nor a fetch-followed
redirect may leave the origin — the client calls `startWebsiteOAuth` and
performs a top-level navigation to the returned authorize URL itself.

Callback resolution order:

1. A **signed-in** user whose live `email_verified_at` is set gets the provider
   identity linked to their account (`/account` has a "Connected accounts" card
   for this; `/discord` is the public connect page for Discord welcome
   messages). An unverified signed-in session is refused
   (`/account?oauthError=email-unverified`) so a password squat cannot attach a
   provider and skip the unverified-account purge. A provider identity already
   linked to a different user is a conflict error, never an account switch;
   other callback errors for signed-in users also redirect to
   `/account?oauthError=<code>` unless the start request carried `redirectTo`
   (for example `/discord?oauthError=<code>`).
2. A known connection signs in its user (the two-factor gate applies exactly as
   it does for password logins; passkey sign-in skips TOTP).
3. A **provider-verified** email matching an existing account links the identity
   and signs that account in. If that account is unverified, the callback
   reclaims it first (unusable password, session lockout, TOTP / passkeys /
   other connections / reset tokens cleared) so a squatted password signup
   cannot keep access. The provider also marks the account email verified, since
   it asserted ownership of the same address.
4. Otherwise a new account is created. Signup is open in every environment. New
   accounts start on the `free` plan.

X frequently does not share an email (it requires the "Request email from users"
app permission and a confirmed email), in which case only paths 1 and 2 work:
connect X from `/account` while signed in, then the X login button works.

Disconnecting a provider from `/account` is refused when it is the account's
only sign-in method (no usable password, no passkey, no other connection).

## Provider app setup

Use `https://<your-domain>/auth/<provider>/callback` as the callback/redirect
URL, for example `https://kody.codes/auth/github/callback`. For local testing
against real providers use `http://localhost:3742/auth/<provider>/callback`.

### GitHub

1. Go to
   [GitHub Developer Settings → OAuth Apps](https://github.com/settings/developers)
   and click **New OAuth App**.
2. Set **Homepage URL** to your app origin and **Authorization callback URL** to
   `https://<your-domain>/auth/github/callback`.
3. Register the app, then create a **client secret**.
4. Save the client id and secret as `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.

Scopes requested: `read:user user:email` (the primary verified email comes from
`GET /user/emails`).

### Google

1. In the [Google Cloud Console](https://console.cloud.google.com/), create or
   select a project.
2. Configure the **OAuth consent screen** (branding, support email; External is
   fine) under **APIs & Services**.
3. Under **Credentials**, create an **OAuth client ID** of type **Web
   application**.
4. Add `https://<your-domain>/auth/google/callback` as an **Authorized redirect
   URI**.
5. Save the client id and secret as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
6. Publish the consent screen (or add test users while in testing mode).

Scopes requested: `openid email profile` (profile read via the OIDC userinfo
endpoint; `email_verified` gates account matching).

### X

1. In the [X Developer Portal](https://developer.x.com/en/portal/dashboard),
   create a project and app.
2. Under the app's **User authentication settings**, enable **OAuth 2.0** with
   type **Web App** (confidential client).
3. Set the **Callback URI** to `https://<your-domain>/auth/x/callback` and the
   **Website URL** to your app origin.
4. Enable **Request email from users** so `confirmed_email` is returned (this
   makes email-based matching and account creation work for X).
5. Save the OAuth 2.0 client id and secret as `X_CLIENT_ID` / `X_CLIENT_SECRET`.

Scopes requested: `tweet.read users.read users.email` (PKCE S256 is mandatory;
the token endpoint uses HTTP Basic client authentication). Note that X meters
`GET /2/users/me` calls under its credit-based API pricing.

### Discord

1. In the
   [Discord Developer Portal](https://discord.com/developers/applications),
   create an application named **Kody**.
2. On the **OAuth2** tab, add `https://<your-domain>/auth/discord/callback` as a
   redirect (production: `https://kody.codes/auth/discord/callback`). For local
   testing against the real provider also add
   `http://localhost:3742/auth/discord/callback`.
3. Copy the **Client ID** and reset/reveal the **Client Secret**.
4. Save them as `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`.

Scopes requested: `identify email guilds.join`. Discord's `verified` field on
`GET /users/@me` gates email-based account matching, the same way Google's
`email_verified` does. Unverified Discord emails can only be linked from
`/account` while already signed in. The `guilds.join` token is used once on the
callback to add the member to the official guild, then discarded.

Do not add `/connect/oauth` to this application. User-owned Discord integrations
for the assistant stay on a separate app and the `/connect/oauth` flow (see
[`docs/guides/providers/discord.md`](../guides/providers/discord.md)).

### Official Kody Discord guild roles

When `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID` are set with at least one role
id, connecting or signing in with Discord best-effort assigns those roles in the
official Kody Discord:

- `DISCORD_MEMBER_ROLE_ID` — assigned to every connected Discord identity
- `DISCORD_STANDARD_ROLE_ID` / `DISCORD_PRO_ROLE_ID` — follow `orgs.stripe_plan`
  (the paid subscription). Checkout, Stripe webhooks, and the plan-refresh alarm
  re-sync these when the subscription changes. They are exclusive: a Pro
  subscriber loses Standard, and a cancelled or free `stripe_plan` loses both.
  Manual grants (including `max`) do not assign a plan role.

Disconnect and account deletion best-effort remove every configured role. Login
and billing still succeed when the bot is unset, join or role writes fail, or
Discord errors.

The bot must already be in the guild with **Create Instant Invite** (needed to
add a member via `guilds.join`) and **Manage Roles**, and its highest role must
sit above every role it assigns. Every successful Discord social-login callback
best-effort adds the user to the official guild
(`PUT /guilds/{id}/members/{user}`) with the operator bot plus the ephemeral
user token, then assigns roles. `/discord` is the shareable **Connect Discord**
page. `/account` still shows a Join the Kody Discord link on a connected Discord
row, plus **Sync Discord roles** when bot config is present.

Social-login tokens are discarded after the profile fetch and the one guild-join
call. Role writes use the operator bot token and the stored Discord snowflake
only. Mock OAuth (`MOCK_*` client ids) has no user token, so join skips.

## Environment variables

The client id/secret pairs are optional Worker secrets; a provider's button only
renders when both of its values are set (see
`packages/worker/src/app/oauth-providers.ts`):

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- `X_CLIENT_ID` / `X_CLIENT_SECRET`
- `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`
- `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID` / `DISCORD_MEMBER_ROLE_ID` /
  `DISCORD_STANDARD_ROLE_ID` / `DISCORD_PRO_ROLE_ID` (optional; bot token +
  guild id enable official Discord guild join; at least one role id enables role
  sync. The bot needs Create Instant Invite and Manage Roles.)

For production deploys, store the social-login client credentials as GitHub
Actions repository secrets named `OAUTH_GITHUB_CLIENT_ID`,
`OAUTH_GITHUB_CLIENT_SECRET`, `OAUTH_GOOGLE_CLIENT_ID`,
`OAUTH_GOOGLE_CLIENT_SECRET`, `OAUTH_X_CLIENT_ID`, `OAUTH_X_CLIENT_SECRET`,
`OAUTH_DISCORD_CLIENT_ID`, and `OAUTH_DISCORD_CLIENT_SECRET` (the `OAUTH_`
prefix avoids colliding with the reserved `GITHUB_*` Actions namespace).
`.github/workflows/deploy.yml` syncs them to the Worker as the unprefixed secret
names when present. The Discord bot token and guild/role ids use the unprefixed
Actions secret names `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`,
`DISCORD_MEMBER_ROLE_ID`, `DISCORD_STANDARD_ROLE_ID`, and `DISCORD_PRO_ROLE_ID`.

## Mocking and tests

A client id starting with `MOCK_` (with any non-empty secret) switches that
provider to an in-worker mock on **non-production runtimes only**
(`isMockOauthProvider` fails closed in production): the start redirect goes
straight back to the callback with a mock code, and the token/profile exchange
returns a canned profile from `getMockOauthProfile` without any network access.
`packages/worker/.env.example` and the `test` Wrangler env ship with MOCK
values, so local dev and Playwright E2E exercise the full redirect round-trip
out of the box. The mock X profile intentionally has no email to mirror the
common real-world case.

Coverage:

- `packages/worker/src/app/handlers/auth-provider.node.test.ts` — full
  start/callback flows against MSW-mocked GitHub/Google/X HTTP endpoints plus
  the mock-mode flow
- `e2e/social-login.spec.ts` — browser sign-in through the mock GitHub provider,
  then connecting Google and Discord from `/account`
