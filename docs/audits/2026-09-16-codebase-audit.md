# Codebase audit — 2026-09-16

Point-in-time review of `kentcdodds/kody` covering security, accessibility,
performance, and related quality risks. This is evidence from the tree as of
this date, not a product-requirements list.

**Method.** Read `docs/contributing/security.md` and architecture docs first so
accepted residuals are not relitigated. Then inspected OAuth, secrets, package
sandboxing, webhooks, email, RBAC, first-party UI, Durable Object hot paths, and
Worker startup. Hunches in the request (OAuth `iss`, `secretLock` vs grants, DO
rows-read, focus/loading UX) were checked against code and tests.

**Fix shipped in the same change.** Finding H1 (`communityForkAdopt` from
package runtimes) has an obvious, low-risk gate matching `packageAppFetch` /
platform-feedback submit. Other findings stay recommendations.

## Severity at a glance

| ID  | Severity | Area          | Title                                                             |
| --- | -------- | ------------- | ----------------------------------------------------------------- |
| H1  | High     | security      | `communityForkAdopt` was callable from package runtimes           |
| H2  | High     | security      | Sandbox stamp ALS runner is reachable via well-known symbols      |
| H3  | High     | performance   | StorageRunner `sqlQuery` row cap (addressed)                      |
| M1  | Medium   | security      | Package runtimes inherit almost the full user capability map      |
| M2  | Medium   | security      | Secret host approval accepts raw IPs                              |
| M3  | Medium   | security      | Inbound mail auth fail-open plus header-From reply                |
| M4  | Medium   | performance   | Mailbox list/search selects full bodies and uses OFFSET           |
| M5  | Medium   | performance   | Platform `RepoSession` statically imports `isomorphic-git`        |
| M6  | Medium   | performance   | Origin SSR graph eagerly imports `marked` via blog                |
| M7  | Medium   | accessibility | Mobile site menu overlay does not trap Tab                        |
| M8  | Medium   | accessibility | Several first-party controls lack honest names                    |
| M9  | Medium   | accessibility | Account/admin client navigations focus `<main>`, not the new `h1` |
| M10 | Medium   | accessibility | Password and OAuth errors are not field-associated                |
| M11 | Medium   | accessibility | Package webhooks section blanks while the rest of settings stay   |
| L1  | Low      | security      | Avatar upload accepts multipart without a Content-Type allowlist  |
| L2  | Low      | security      | OIDC logout is a mutating GET; open DCR can redirect after logout |
| L3  | Low      | security      | Standalone authorize error HTML interpolates the message, no CSP  |
| L4  | Low      | security      | Resend-verification mutates without requiring JSON Content-Type   |
| L5  | Low      | performance   | UserMeter deletes stale counters on every consume                 |
| L6  | Low      | accessibility | Success toasts auto-dismiss in 4s                                 |
| N1  | Note     | security      | MCP OAuth `iss` stamping is complete for client redirects         |
| N2  | Note     | security      | `secretLock` does not apply grants                                |
| N3  | Note     | accessibility | No-flash navigation is real on the main account/docs shells       |

No Critical finding (remote unauthenticated takeover, cross-user data read, or
first-party credential leak to package code) showed up in the surfaces reviewed.

---

## High

### H1 — `communityForkAdopt` was callable from package runtimes

- **Area:** security
- **Location:** `communityForkAdoptCapability` in
  `packages/worker/src/mcp/capabilities/community/adopt.ts`;
  `PackageAppRuntimeBridge.callCapability` in
  `packages/worker/src/package-runtime/package-app.ts`;
  `savedPackageHasImplicitUserSecretReadAccess` in
  `packages/worker/src/mcp/secrets/package-access.ts`
- **Evidence:** Adoption is the second user-secret grant next to website
  `allowed_packages`. `secretLock` is read-only and does not write grants.
  Implicit read/use is “no `community_forks` row, or `adopted_at` set.”
  `communityForkAdopt` only required a 10-character `review_summary` and the
  caller `userId`. It did not check `executionOrigin` or empty `storageContext`,
  unlike `packageAppFetch`, `packageSubscriptionDispatch`, and platform-feedback
  submit. Package apps expose the full capability map through `callCapability`.
  Jobs, webhooks, and package-export runs build a background caller with
  `packageId` set
  (`packages/worker/src/package-invocations/module-execution.ts`). After adopt,
  `packageSecrets.get` returns plaintext and non-secret sandbox `fetch` has no
  host allowlist (documented residual).
- **Impact:** Installing an unadopted community fork is supposed to deny
  user-secret read until a website Allow or a reviewed adopt. The fork could
  adopt itself, then read every user secret and exfiltrate them.
- **Fix in this change:** Same gate as `packageAppFetch`:
  `executionOrigin === 'interactive'` and empty package/app/storage context.
  Missing origin fails closed. Capability copy and usage docs now say package
  runtimes cannot adopt. Security invariant 15 records it.
- **Residual:** Interactive `execute()` still inherits the agent caller context,
  so imported package code inside an agent execute can still reach the
  capability unless it is removed from the sandbox `kody.*` map. Treat that as a
  follow-up (exclude `communityForkAdopt` from `buildKodyFns`, or require a
  website Allow like `secretLock`).
- **False-positive risk:** Low for background/package-app self-adopt. Medium for
  “every execute import is an attack” — running code via `execute` is also how
  agents act as the user.

### H2 — Sandbox stamp ALS runner is reachable via well-known symbols

- **Area:** security
- **Location:** `createRuntimeModuleSource` in
  `packages/worker/src/package-runtime/runtime-source-modules.ts`
  (`Symbol.for('kody.getSecretAuthority')` /
  `Symbol.for('kody.runWithSecretAuthority')`);
  `resolveSecretAuthorityPackageId` in
  `packages/worker/src/mcp/secrets/secret-authority.ts`; steal coverage in
  `packages/worker/src/package-runtime/package-secret-authority.workers.test.ts`
- **Evidence:** The getter on `globalThis` is non-writable. The **run** function
  is hung off that getter with another `Symbol.for` key.
  `Object.getOwnPropertySymbols(get)` still returns it. Host policy accepts any
  id in the packageStorage grant set (run + static/dynamic deps). Existing tests
  deny B calling `packageSecretGet` with A’s id, and deny B reading an A-only
  secret through unstamped `packageSecrets`. They do not cover B calling the run
  symbol with A’s UUID. Fetch / `kody.*` wrappers copy whatever the getter
  returns.
- **Impact:** Same-user stamp bypass. If B imports A, B’s code can act as A for
  `packageSecrets`, `{{secret}}`, and mutate checks. If A is self-authored,
  implicit read covers all user secrets, not only A’s `allowed_packages`. Not
  cross-user.
- **Recommended fix:** Keep `runWithSecretAuthority` in a closure only the
  bundler wrapper holds. Do not put the ALS or the runner on any user-reachable
  `globalThis` object. Prefer a singleton `kody:runtime` module that is never
  inlined, so later evaluations import the same closure. Add a workers test that
  performs the symbol steal and expects denial.
- **False-positive risk:** Low that the symbols are reachable. Medium that every
  community package can name a useful grant id (it must already be in the run’s
  grant set). Not exercised as a live PoC in this review.

### H3 — StorageRunner `sqlQuery` row cap (addressed)

- **Area:** performance (customer bill and operator DO rows-read)
- **Location:** `StorageRunnerBase.sqlQuery` / `cursorToSqlResult` in
  `packages/worker/src/storage-runner.ts`; `recordDurableObjectRowsRead` in
  `packages/worker/src/usage/durable-object-rows.ts`
- **Evidence (audit date):** Caller SQL ran and `cursor.toArray()` materialized
  the full result with no LIMIT rewrite or `rowsRead` abort.
  `durable_object_rows_read` meters this path for monthly overage. KV
  list/export was already paged.
- **Status:** Addressed. `cursorToSqlResult` stops collecting at
  `maxStorageSqlQueryRows` (same budget as the export page size) and sets
  `truncated` when more rows remain. Mutating statements can drain overflow so
  RETURNING still finishes; read-only SELECT/EXPLAIN/PRAGMA stop early.
- **Residual:** Authors can still write an unbounded `SELECT` that walks a large
  cursor before the cap truncates the returned rows; metering still sees
  `rowsRead`. The platform no longer returns an uncapped result array.

---

## Medium

### M1 — Package runtimes inherit almost the full user capability map

- **Area:** security
- **Location:** `PackageAppRuntimeBridge.callCapability`; `buildKodyFns` in
  `packages/worker/src/mcp/run-kody-registry.ts`; `communityPublish`,
  `packageDelete`, `packageShareInvite`, `packageUpdate`, and most other
  unguarded capabilities
- **Evidence:** Registry filtering is role / permission / feature-flag only.
  Interactive-only gates exist on `packageAppFetch`,
  `packageSubscriptionDispatch`, platform-feedback submit, external-publish
  escalation, and (after H1) `communityForkAdopt`. `packageDelete` is
  prompt-gated (`confirm_name` must match) but a package that knows its own or a
  sibling’s name can pass that. `communityPublish` can list and publish another
  owned private package.
- **Impact:** A running community fork can mutate the owner’s account surface
  (publish, delete, share) even when secret read is denied. This may be
  intentional “packages act as the user” for some tools; it is inconsistent with
  the consent-sensitive gates that already exist.
- **Recommended fix:** Inventory mutating capabilities. Mark consent-sensitive
  ones `directMcpOnly` (shared helper + omit from sandbox `kody.*`). Do not
  invent a blanket “packages cannot call `kody.*`.”
- **False-positive risk:** Medium. Email send, storage, and similar are meant to
  run from packages.

### M2 — Secret host approval accepts raw IPs

- **Area:** security
- **Location:** `classifyNormalizedApprovalHost` in
  `packages/worker/src/mcp/secrets/approval-host-shape.ts`
- **Evidence:** Canonical IPv4/IPv6 hosts are accepted (`reason: null`). There
  is no private / link-local / metadata denylist. Secret-bearing fetch only
  checks exact `allowedHosts` membership. Non-secret fetch has no SSRF denylist
  (documented residual).
- **Impact:** A one-click `/connect/secrets` link can ask the owner to allow
  `169.254.169.254` or `[::1]`. If they click Allow, `{{secret}}` is sent there.
  Workers egress may not reach classic cloud metadata.
- **Recommended fix:** Reject IPs, or at least RFC1918 / link-local / loopback /
  metadata ranges, in `classifyNormalizedApprovalHost`.
- **False-positive risk:** Medium. The UI shows the host (user consent). Still a
  confused-deputy vector via approval URLs.

### M3 — Inbound mail auth fail-open plus header-From reply

- **Area:** security
- **Location:** `resolveInboundEmailAuthVerdict` in
  `packages/worker/src/email/auth-verdict.ts`; `deriveReplyRecipient` in
  `packages/worker/src/email/outbound.ts`
- **Evidence:** Missing/unparseable `Authentication-Results` is not suspect
  (accepted). Tests store “No auth header” as accepted. `Authentication-Results`
  is the first header, not a Cloudflare-only auth object. Reply prefers
  `Reply-To`, then header From, then envelope. Fail-open is partly documented in
  `docs/contributing/security.md`.
- **Impact:** Spoofed mail can land as accepted and dispatch
  `email.message.received`. Auto-reply packages send to the spoofed
  From/Reply-To.
- **Recommended fix:** Prefer the last (outermost) AR header, or Cloudflare’s
  authenticated result if exposed. Treat missing AR as suspect in production.
  For `emailReply`, prefer envelope From when DMARC/SPF did not pass.
- **False-positive risk:** Medium. Cloudflare Email Routing may already reject
  double-fail SPF+DKIM and prepend AR.

### M4 — Mailbox list/search selects full bodies and uses OFFSET

- **Area:** performance (operator DO rows-read and RPC size)
- **Location:** `MailboxStore.listMessages` / `searchMessages` / `countMessages`
  in `packages/worker/src/email/mailbox-store.ts`; `listOwnerEmailMessagesPage`
  in `packages/worker/src/email/owner-email-reader.ts`
- **Evidence:** `SELECT * FROM email_messages` includes `text_body` /
  `html_body` (up to 64 KiB each) plus `headers_json`. Account UI then drops
  bodies in `messageToListItem`. Search is
  `INSTR(LOWER(subject|from_address|envelope_from))`. Every list page also runs
  `COUNT(*)`. A `(created_at, id)` cursor exists but account UI still uses
  LIMIT/OFFSET.
- **Impact:** A 25-row page can move megabytes over DO RPC. Deep pages and
  searches are O(n). This cost is **not** in the customer
  `durable_object_rows_read` meter (StorageRunner only).
- **Recommended fix:** Metadata-only list columns; load bodies on `getMessage`.
  Use the cursor; drop or approximate COUNT. Add FTS or indexed lowercase
  columns if search stays hot.
- **False-positive risk:** Low for column set. Medium for “users page deep
  enough for OFFSET to matter.”

### M5 — Platform `RepoSession` statically imports `isomorphic-git`

- **Area:** performance (Worker startup)
- **Location:** `packages/worker/src/repo/repo-session-do.ts`;
  `packages/worker/src/repo/isomorphic-git-lazy.ts`;
  `docs/contributing/architecture/startup-budget.md`
- **Evidence:** `isomorphic-git-lazy.ts` exists because a static import
  re-eagerizes the lib. `RepoSession` still
  `import rawGit from 'isomorphic-git'`. `platform-worker.ts` exports
  `RepoSession`. Origin slim entry is clean.
- **Impact:** Platform startup CPU sits closer to Cloudflare’s upload ceiling.
  The budget doc already names `isomorphic-git` as a heavy module-scope lib.
- **Recommended fix:** Route git through `loadIsomorphicGit()`.
- **False-positive risk:** Low.

### M6 — Origin SSR graph eagerly imports `marked`

- **Area:** performance (Worker startup)
- **Location:** origin router → `packages/worker/src/app/handlers/blog.ts` →
  highlight/markdown path; `startup-budget.md`
- **Evidence:** `marked` is listed as a heavy module-scope lib. The origin
  router statically imports blog. Client `markdown-view.tsx` is already in a
  lazy community/blog chunk.
- **Impact:** Origin isolate evaluation pays markdown/highlight cost on every
  worker start, including routes that never render a post.
- **Recommended fix:** Dynamic-import highlight/markdown from those handlers.
- **False-positive risk:** Medium if blog is already on a lazy origin chunk in
  the Vite slim graph (confirm with `wrangler check startup`).

### M7 — Mobile site menu overlay does not trap Tab

- **Area:** accessibility
- **Location:** `SiteHeader` in
  `packages/worker/start/components/site-header.tsx`
- **Evidence:** Native `popover` light-dismisses on Escape/outside click and
  uses a dimmed `::backdrop`, but does not trap Tab. Tab from the last menu link
  continues into content behind the overlay.
- **Impact:** Phone keyboard/switch users can leave a visually modal menu and
  operate the page underneath.
- **Recommended fix:** `<dialog popover>` + `showModal()`, or wrap Tab while
  open. Keep Escape and invoker focus return. Add `aria-controls={menuPanelId}`.
- **False-positive risk:** Medium if the menu is treated as a disclosure rather
  than a modal. The backdrop argues modal.

### M8 — Several first-party controls lack honest names

- **Area:** accessibility
- **Location:**
  - `YouTubeLightPlayer` in
    `packages/worker/start/components/youtube-light-player.tsx` (visually hidden
    “Play video”; `title` is iframe-only)
  - `ProfileRepositorySearchInput` in
    `packages/worker/start/components/profile-search-field.tsx`
    (`role="searchbox"`, placeholder only, no `aria-label`)
  - `renderCopyPromptPill` in
    `packages/worker/start/components/fork-outdated-copy-button.tsx` (visible
    “Fork outdated” / “Forked”; real instruction is `aria-hidden` tooltip via
    `aria-describedby`)
  - Secret allowed-host rows in
    `packages/worker/start/pages/secret-editor-fields.tsx`
- **Impact:** Homepage play, `/@username` search, community copy pills, and
  secret-host fields fail WCAG 4.1.2 / 3.3.2 for screen reader users.
- **Recommended fix:** `Play ${title}` on the poster button;
  `aria-label="Search repositories"`; accessible name
  `Copy update prompt (fork outdated)`; `aria-label` on each host field and
  Remove.
- **False-positive risk:** Low.

### M9 — Account/admin client navigations focus `<main>`, not the new `h1`

- **Area:** accessibility
- **Location:** `listenToRouterNavigationEnd` in
  `packages/worker/start/routes/__root.tsx`
- **Evidence:** Docs set `data-docs-heading` on the article `h1` and focus that.
  Account/admin `h1`s have no equivalent, so focus lands on the `#main`
  landmark.
- **Impact:** After rail clicks (Jobs → Secrets), SR users hear the landmark,
  not the new page title.
- **Recommended fix:** Reuse the docs heading hook on account/admin `h1`s. Do
  not clear the previous page while waiting.
- **False-positive risk:** Low. Some teams treat landmark focus as enough; this
  app already chose heading focus for docs.

### M10 — Password and OAuth errors are not field-associated

- **Area:** accessibility
- **Location:** `AccountPasswordPanel`; login `?oauthError=` live text;
  delete-account / delete-package dialogs
- **Evidence:** Login/signup use `fieldErrorProps` (`aria-invalid` +
  `aria-describedby`). Password mismatch/current-password errors render as
  `role="status"`. OAuth query errors are `aria-live="polite"` with no
  `role="alert"`.
- **Impact:** SR users hear a status somewhere on the page, not “this field is
  invalid.”
- **Recommended fix:** Reuse `fieldErrorProps`. Use `role="alert"` for failures.
- **False-positive risk:** Low.

### M11 — Package webhooks section blanks while the rest of settings stay

- **Area:** accessibility / loading UX
- **Location:** `createPackageWebhooksController.render` in
  `packages/worker/start/pages/package-webhook-settings.tsx`
- **Evidence:**
  `showLoading = !isCurrent || status === 'idle' || status === 'loading'`
  replaces the card list with “Loading webhooks…”. Parent settings correctly
  keep the previous package via `createRouteData`.
- **Impact:** Settings → Webhooks (and package change) collapses height and
  rebuilds the structure for AT.
- **Recommended fix:** Keep the last webhook list under `aria-busy`. Do not
  clear the section.
- **False-positive risk:** Low for first visit (nothing to keep).

---

## Low

### L1 — Avatar upload accepts multipart without a Content-Type allowlist

- **Area:** security
- **Location:** `createAccountAvatarApiPostHandler` in
  `packages/worker/src/app/handlers/account-avatar.ts`
- **Evidence:** After the JSON `remove: true` branch, any other body is parsed
  as `FormData`. Invariant 10 says not to add multipart mutating endpoints
  without CSRF tokens. Cross-site HTML form POST should not send `kody_session`
  (`SameSite=Lax`).
- **Impact:** Defense-in-depth hole if SameSite is ever relaxed.
- **Recommended fix:** Reject unless `Content-Type` is `multipart/form-data`
  (upload) or `application/json` (remove).
- **False-positive risk:** High for “exploitable CSRF today.”

### L2 — OIDC logout is a mutating GET; open DCR can redirect after logout

- **Area:** security
- **Location:** `handleOidcLogoutRequest` in
  `packages/worker/src/oidc/logout.ts`
- **Evidence:** GET/HEAD/POST all clear `kody_session`. `SameSite=Lax` sends the
  cookie on top-level GET. `post_logout_redirect_uri` is allowed when it matches
  a registered client URI. Open DCR is an accepted residual.
- **Impact:** `GET /oauth/logout` logs the victim out. With a DCR client whose
  `redirect_uris` includes the attacker origin, the browser is sent there. No
  account takeover.
- **Recommended fix:** Require POST or `id_token_hint` before clearing the
  session / honoring `post_logout_redirect_uri`.
- **False-positive risk:** Medium. RP-initiated logout is specified as GET.

### L3 — Standalone authorize error HTML interpolates the message, no CSP

- **Area:** security
- **Location:** `standaloneAuthorizeErrorHtmlResponse` in
  `packages/worker/src/oauth-handlers.ts`
- **Evidence:** Used for GET/HEAD authorize errors that cannot redirect
  (including some `prompt=none` parse failures). Message is interpolated raw.
  Headers are only `Cache-Control` + `Content-Type`. Interactive authorize
  errors go through `render()` and first-party headers. Today’s
  `AuthorizationError` strings are static.
- **Impact:** If an error string ever includes request-controlled HTML, this
  page has no CSP backstop.
- **Recommended fix:** HTML-escape `message`; apply
  `applyFirstPartySecurityHeaders`.
- **False-positive risk:** Medium for “exploitable XSS now.”

### L4 — Resend-verification mutates without requiring JSON Content-Type

- **Area:** security
- **Location:**
  `packages/worker/src/identity/account-resend-verification-operations.ts`
- **Evidence:** Non-JSON requests still send mail; `redirectTo` comes from the
  query string. Rate-limited. SameSite still blocks cross-site POST cookies.
- **Impact:** Extra verification emails if SameSite fails.
- **Recommended fix:** Require `application/json` (or 415).
- **False-positive risk:** High for exploitability.

### L5 — UserMeter deletes stale counters on every consume

- **Area:** performance
- **Location:** `deleteStaleCounters` in the UserMeter Durable Object
- **Evidence:** Execute, email, and fetch consume paths run
  `DELETE … WHERE day < ?`. An index exists; most DELETEs match 0 rows.
- **Impact:** Extra SQLite work on the hottest entitlement path.
- **Recommended fix:** Throttle to once per UTC day in DO meta.
- **False-positive risk:** Medium (cheap no-op deletes).

### L6 — Success toasts auto-dismiss in 4s

- **Area:** accessibility
- **Location:** `defaultToastDurationMs` in `packages/worker/client/toast.ts`
- **Evidence:** info/success: 4000ms; error: persist. WCAG 2.2.1 expects ≥10s or
  a way to extend.
- **Impact:** “Password updated.” / action toasts can vanish before Tab reaches
  them.
- **Recommended fix:** Default ≥10s, or persist whenever `action` is set.
- **False-positive risk:** Medium if every success toast is also inline.

---

## Notes (verified hunches and accepted residuals)

### N1 — MCP OAuth `iss` stamping is complete for client redirects

Hunch: authorize redirects / `iss` completeness.

`withAuthorizationResponseIssuer` overwrites `iss` on every outbound client
redirect (success, deny, `prompt=none` errors). `authRequest.issuer` is set to
`getAppBaseUrl` before `completeAuthorization`. Tests cover success, deny,
clobber of a bad `iss`, ChatGPT, and malformed `max_age`. Invalid `redirect_uri`
stays on a local error page (must not redirect). PKCE is S256-only at the app
layer.

Some valid-client errors stay on Kody rather than redirecting to the client.
That is stricter than RFC 6749, not an `iss` omission.

### N2 — `secretLock` does not apply grants

Hunch: package secret grant UX vs `secretLock`.

Handler only calls `inspectUserSecretPackageGrant` (`readOnly: true`). Tests
assert `allowed_packages` is unchanged. Website Allow /
`setSecretAllowedPackages` / `lockSecretToPackage` are the mutators.
`/connect/secrets` does not POST on load. The grant hole next to `secretLock`
was H1 (`communityForkAdopt`), not the lock capability.

### N3 — No-flash navigation is real on the main shells

`createRouteData` keeps the last-good payload. E2E fails if `<main>` loses its
`h1` or shows loading copy in place of content. Pending UI is a visually hidden
`role="status"`. Do not “fix” loading by clearing the previous page.

Dialogs use native `<dialog>.showModal()`. Skip link, `:focus-visible`, and
labeled navs are in place. Contrast tokens document AA measurements.

### Accepted residuals (do not relitigate)

From `docs/contributing/security.md` and matching code:

- Open `/oauth/register` (MCP DCR)
- No CSRF tokens while JSON Content-Type + `SameSite=Lax` hold
- Stateless cookies; “log out everywhere” is password change
- Account secret reveal is session-scoped, not step-up reauth
- Signup email-enumeration via `Set-Cookie` presence
- PBKDF2-SHA256 100k (platform cap)
- Sandbox non-secret fetch has no general SSRF denylist
- Package inbound webhook HMAC/replay is opt-in (URL secret is the default
  credential)
- Same-owner package apps share one subdomain
- `/mcp` anonymous bad-token denials are not audited
- Unverified social reclaim / verified-email auto-link (invariants 12–13)

---

## False-positive risks

- **H2** is code-backed, not a live workers PoC in this review.
- **M1** can over-report if the product model is “any running package acts as
  the user.” The report treats only consent-sensitive grants as bugs.
- **M3 / M2** overlap documented residuals; they add specifics (first AR header,
  header-From reply, IP hosts) rather than reopening SSRF/email fail-open from
  scratch.
- **Accessibility High-looking items were rated Medium** unless a critical task
  is blocked. No axe or browser pass was run; names and roles are from source.
- **Performance costs** split operator DO rows-read (Mailbox, UserMeter,
  RepoSession) from the customer `durable_object_rows_read` meter (StorageRunner
  `sqlQuery` only).

## What this review did not cover

- Production config, Cloudflare WAF/rate-limit dashboards, or live traffic
- Dependency CVEs (`npm audit`) as a scored finding
- DR worker / Access JWT path beyond the documented model
- Hosted package **author** UI (out of scope except platform chrome)
- Status, nx-cache, and highlight workers beyond startup notes
- A full capability-by-capability RBAC matrix
- Visual/browser accessibility (axe, VoiceOver, keyboard walkthrough)
- Load tests or Analytics Engine percentiles
- Stripe, Discord bot, or third-party provider account hardening

## Suggested follow-up issues

1. **Exclude `communityForkAdopt` from sandbox `kody.*`** (H1 residual) so
   imported package code inside interactive `execute` cannot adopt.
2. **Hide the stamp ALS runner from user code** (H2) + workers steal test.
3. **Cap StorageRunner SQL rows** (H3).
4. **`directMcpOnly` inventory** for publish/delete/share (M1).
5. **Mailbox metadata-only list + cursor** (M4).
6. **Lazy `isomorphic-git` / `marked`** (M5, M6).
7. **First-party a11y pack:** menu trap, names, heading focus, field errors,
   webhooks keep-last (M7–M11).
8. **Optional:** reject IP hosts; tighten inbound AR / reply-From.
