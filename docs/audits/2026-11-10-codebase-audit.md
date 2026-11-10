# Codebase audit — 2026-11-10

Point-in-time review of `kody-hq/kody` at `7f94a7b` covering security,
performance, accessibility, usability, and maintainability. Written as a
handoff: Part 1 is decisions for the owner, Part 2 is work an implementing agent
can pick up.

**Sort order.** Both parts run from _least_ confident about the right fix (top)
to _obvious_ (bottom). Severity is a separate label on each item.

**Method.** Source reading only. Nothing was run: the container had no
`node_modules` and Node 22 (the repo needs 26), so there is no test, build, axe,
or browser evidence behind any finding. Read
[`docs/contributing/security.md`](../contributing/security.md) and the
[2026-09-16 audit](./2026-09-16-codebase-audit.md) first; accepted residuals are
not relitigated. Then swept the whole tree with pattern searches and read the
entrypoints and the surfaces the last audit skipped (ops workers, desktop, CLI,
CI). About 270k non-test source lines exist; most were sampled, not read. See
[coverage](#coverage-and-limits).

**Headline.** No Critical finding. Classic web risks (SQL, XSS sinks, token
storage, webhook signatures, CSRF, raw-file serving, CI triggers) are in good
shape. The real exposure is at the edges of the product: the desktop app and the
self-updating CLI daemon, both of which run with the user's local privileges.

## For the implementing agent

- Line numbers are from `7f94a7b` and will drift. Find the named function.
- Each item lists **Verify**: do that before fixing. Several items are
  inferences from code and may be wrong.
- `npm run validate` is the gate. Follow
  [testing principles](../contributing/testing-principles.md) and
  [code style](../contributing/code-style.md).
- Do not start Part 1 items. They need the owner's answer. Where a Part 2 item
  depends on one, it says so.
- Do not reopen the
  [accepted residuals](../contributing/security.md#accepted-residual-risks-and-out-of-scope-items).
- Group the bottom of Part 2 freely. Keep E1–E5 as separate changes.

## Index

Part 1, product decisions:

| ID  | Severity | Area          | Decision                                               |
| --- | -------- | ------------- | ------------------------------------------------------ |
| D1  | High     | security      | What the CLI daemon trusts when it auto-updates        |
| D2  | Medium   | security      | macOS entitlements the desktop app ships with          |
| D3  | Medium   | security      | Which capabilities a running package may call          |
| D4  | Medium   | security      | 2FA recovery: email reset removes every second factor  |
| D5  | Medium   | security      | Inbound mail with no authentication result is accepted |
| D6  | Low      | security      | IP literals as secret approval hosts                   |
| D7  | Low      | security      | OIDC logout over GET                                   |
| D8  | Low      | reliability   | XState 6 beta in shipped CLI and desktop builds        |
| D9  | Low      | security      | Password policy is length only                         |
| D10 | Low      | accessibility | Mobile menu: modal or disclosure                       |
| D11 | Low      | security      | HSTS preload                                           |
| D12 | Low      | accessibility | Toast timing                                           |
| D13 | Note     | docs          | "Scoped by `userId`" wording now that orgs exist       |

Part 2, engineering:

| ID  | Severity | Area            | Fix confidence | Title                                                    |
| --- | -------- | --------------- | -------------- | -------------------------------------------------------- |
| E1  | High     | security        | Low            | Desktop has no Electron fuses and forks with RunAsNode   |
| E2  | Medium   | security        | Low            | `kody_session` lacks the `__Host-` prefix                |
| E3  | Medium   | accessibility   | Low            | Axe gate covers 7 routes                                 |
| E4  | Low      | security        | Medium         | `COOKIE_SECRET` rotation is a hard cut                   |
| E5  | Medium   | security        | Medium         | Auto-update install runs scripts; Windows shell quoting  |
| E6  | Medium   | accessibility   | Medium         | Focus rings vanish in forced-colors mode                 |
| E7  | Low      | security        | Medium         | First-party pages miss COOP, Permissions-Policy, reports |
| E8  | Medium   | security        | Medium         | DR control plane accepts any Access service token        |
| E9  | Medium   | maintainability | Medium         | File-size ratchet guards an empty glob                   |
| E10 | Low      | performance     | Medium         | OFFSET paging and `LIKE` scans on list and search        |
| E11 | Low      | maintainability | Medium         | Desktop main process is untyped CommonJS                 |
| E12 | Low      | maintainability | Medium         | Three compatibility dates across the fleet               |
| E13 | Medium   | security        | Medium         | API edge rate-limit keys are caller-chosen               |
| E14 | Medium   | accessibility   | Medium         | Account and admin navigation focuses `<main>`            |
| E15 | Medium   | security        | Medium         | API docs CSP allows all of jsDelivr                      |
| E16 | Medium   | accessibility   | High           | Password errors are not tied to their fields             |
| E17 | Low      | performance     | High           | UserMeter runs stale-row deletes on every consume        |
| E18 | Medium   | security        | High           | Status and DR pages send no security headers             |
| E19 | Low      | security        | High           | Authorize error page interpolates raw text               |
| E20 | Low      | security        | High           | Resend-verification accepts any content type             |
| E21 | Low      | security        | High           | `isSecureRequest` trusts client proto headers            |
| E22 | Medium   | performance     | High           | Three 1.2–1.8 MB PNGs on error and signup pages          |
| E23 | Low      | accessibility   | High           | Profile repository search has no accessible name         |
| E24 | Low      | accessibility   | High           | Stale axe exclusion on `/login` and `/signup`            |
| E25 | Low      | maintainability | High           | `client/routes/` holds no routes                         |
| E26 | Low      | maintainability | High           | Housekeeping bundle                                      |

---

## Part 1 — Product decisions

### D1 — What the CLI daemon trusts when it auto-updates

- **Severity:** High (fleet-wide code execution if the trust root fails)
- **Location:** `fetchLatest`, `downloadTarball`, `npmInstall` in
  `packages/cli/src/execution-context/auto-update.ts`; publish in
  `tools/publish-cli.ts:218`
- **Evidence:** Every ~4 hours a daemon reads the `latest` dist-tag from
  `registry.npmjs.org`, downloads the tarball, and checks it against the
  `sha512` integrity value **from that same registry response**. That proves the
  download was not corrupted. It does not prove who published it. Publish
  already uses `--provenance`, but nothing verifies the attestation on the
  receiving side. There is no minimum release age. The install then runs
  `npm install --omit=dev --no-package-lock`, so transitive dependencies resolve
  fresh on each machine (see E5). Daemons with the command grant run arbitrary
  shell commands as the user.
- **Impact:** A stolen npm token, a compromised maintainer account, or one bad
  transitive release reaches every auto-updating machine within hours, with no
  human in the loop.
- **Options:**
  1. Verify npm provenance (Sigstore attestation bound to `kody-hq/kody` +
     `publish-cli.yml`) before installing. Strongest; adds a verification
     dependency or a call to `npm audit signatures`.
  2. Add a release-age cooldown (for example 24–72 hours) so a bad publish can
     be yanked first. Cheap; delays fixes by the same window.
  3. Serve a signed version manifest from `kody.codes` that names the allowed
     version and integrity. Moves the trust root to infrastructure already held;
     a second thing to operate.
  4. Ship dependencies bundled or with `npm-shrinkwrap.json` so the tarball is
     the whole trust unit.
- **Recommendation:** 1 plus 4. Add 2 if 1 slips.

### D2 — macOS entitlements the desktop app ships with

- **Severity:** Medium
- **Location:** `packages/desktop/assets/entitlements.mac.plist`; `build.mac` in
  `packages/desktop/package.json`
- **Evidence:** The signed app claims `allow-jit`,
  `allow-unsigned-executable-memory`, `disable-library-validation`,
  `automation.apple-events`, and `personal-information.addressbook`.
- **Impact:** These decide what an attacker gains from E1. With library
  validation off and RunAsNode on, any local process can run code under Kody's
  identity and inherit its Contacts and Automation grants.
- **Decision:** Which of these does the product need? Contacts and Apple Events
  back host commands that message people. `disable-library-validation` exists
  for native modules (`@napi-rs/keyring`) and may be droppable if those are
  signed with the same team id.
- **Recommendation:** Keep Contacts and Apple Events only if host commands need
  them on every install; otherwise request them lazily. Try removing
  `disable-library-validation` and `allow-unsigned-executable-memory` as part of
  E1.

### D3 — Which capabilities a running package may call

- **Severity:** Medium (carried from 2026-09-16 M1; not re-verified in depth)
- **Location:** `buildKodyFns` in
  `packages/worker/src/mcp/run-kody-registry.ts`;
  `PackageAppRuntimeBridge.callCapability` in
  `packages/worker/src/package-runtime/package-app.ts`
- **Evidence:** `requiresLivePerson` now gates member, role, invite, and billing
  changes. No `directMcpOnly` marker exists. Publish, delete, and share were not
  re-checked.
- **Decision:** Is "a running package acts as its enabler" the model for
  publish, delete, and share, or do those need a live person too?
- **Recommendation:** Extend `requiresLivePerson` to `communityPublish`,
  `packageDelete`, and share grants. A fork should not be able to republish or
  delete its owner's other packages.

### D4 — 2FA recovery: email reset removes every second factor

- **Severity:** Medium
- **Location:** `confirmWebsitePasswordReset` (security invariant 14); no
  recovery-code code exists (no match for recovery or backup codes in
  `packages/worker`)
- **Evidence:** Confirming a password reset disables TOTP and deletes passkeys
  and linked providers. This is documented and deliberate. It is also the only
  recovery path.
- **Impact:** Control of the mailbox is enough to take an account that has 2FA
  on. 2FA protects against a leaked password, not a compromised inbox.
- **Options:** (a) Keep as is and say so in the 2FA settings copy. (b) Add
  one-time recovery codes and make email reset keep second factors when codes
  exist. (c) Add a delay plus notification before factors are cleared.
- **Recommendation:** (b). (a) at minimum, because users assume more.

### D5 — Inbound mail with no authentication result is accepted

- **Severity:** Medium (carried from M3; `deriveReplyRecipient` re-verified
  unchanged at `packages/worker/src/email/outbound.ts:288`)
- **Evidence:** Missing or unparseable `Authentication-Results` is not treated
  as suspect. Replies go to `Reply-To`, then header `From`, then the envelope
  sender.
- **Impact:** Spoofed mail can trigger `email.message.received` and make
  auto-reply packages send to a forged address.
- **Decision:** Fail open (deliverability) or quarantine (safety) when the
  header is absent in production.
- **Recommendation:** Quarantine when absent. Reply to the envelope sender
  unless DMARC passed.

### D6 — IP literals as secret approval hosts

- **Severity:** Low (carried from M2; re-verified open)
- **Location:** `classifyNormalizedApprovalHost` in
  `packages/worker/src/mcp/secrets/approval-host-shape.ts` (IPv4 at ~81, IPv6 at
  the top of the function)
- **Evidence:** Canonical IPv4 and IPv6 hosts pass with no private, loopback, or
  link-local denylist.
- **Decision:** Do self-hosters need to approve secrets for a bare IP?
- **Recommendation:** Reject all IP literals. If that is too strict, reject RFC
  1918, loopback, link-local, and unique-local ranges.

### D7 — OIDC logout over GET

- **Severity:** Low (carried from L2; re-verified open at
  `packages/worker/src/oidc/logout.ts:83`)
- **Evidence:** GET, HEAD, and POST all clear the session.
- **Decision:** RP-initiated logout is specified as GET. Requiring
  `id_token_hint` keeps the spec and stops drive-by logout.
- **Recommendation:** Require `id_token_hint` for GET; show a confirm page
  without it.

### D8 — XState 6 beta in shipped CLI and desktop builds

- **Severity:** Low
- **Location:** `"xstate": "6.0.0-beta.1"` in six `package.json` files,
  including `packages/cli` and `packages/desktop` (commit `7f94a7b`)
- **Impact:** A pre-release state-machine runtime now sits under lifecycle code
  in production workers and in binaries users install. Betas can change behavior
  between releases, and the CLI resolves it at install time on user machines.
- **Decision:** Accept, or hold the CLI and desktop on a stable line until 6.0
  ships.
- **Recommendation:** Accept for workers (exact pin, tested, quick rollback).
  Reconsider for CLI and desktop, where rollback means a new release that users
  must pick up.

### D9 — Password policy is length only

- **Severity:** Low
- **Location:** `packages/shared/src/password-policy.ts` (8–128 characters)
- **Decision:** Add a breached-password check (Have I Been Pwned range API,
  k-anonymity) at signup, reset, and change. Costs one outbound request per
  password set and a dependency on a third party.
- **Recommendation:** Add it, failing open on network errors. The PBKDF2
  iteration cap makes weak passwords cheaper to crack here than elsewhere.

### D10 — Mobile menu: modal or disclosure

- **Severity:** Low (carried from M7; re-verified open)
- **Location:** `SiteHeader` in
  `packages/worker/start/components/site-header.tsx` (`popover="auto"`, ~198)
- **Evidence:** The menu dims the page behind it but Tab leaves it.
- **Decision:** If it is modal, trap focus (`<dialog>` + `showModal()`). If it
  is a disclosure, drop the backdrop.
- **Recommendation:** Modal.

### D11 — HSTS preload

- **Severity:** Low
- **Location:** `firstPartySecurityHeaders` in
  `packages/worker/src/app/security-headers.ts`
- **Evidence:** `max-age=31536000; includeSubDomains`, no `preload`.
- **Decision:** Preloading is hard to undo and binds every subdomain of
  `kody.codes` to HTTPS forever.
- **Recommendation:** Add `preload` and submit, once every subdomain is known to
  serve HTTPS.

### D12 — Toast timing

- **Severity:** Low (carried from L6; re-verified open)
- **Location:** `defaultToastDurationMs` in
  `packages/worker/client/toast.ts:31`;
  `packages/worker/start/components/toaster.tsx`
- **Evidence:** Info and success toasts close after 4 seconds. The toaster has
  no pause on hover or focus.
- **Recommendation:** Pause the timer on hover and focus, and never auto-close a
  toast that carries an action. That meets WCAG 2.2.1 without making every toast
  linger.

### D13 — "Scoped by `userId`" wording now that orgs exist

- **Severity:** Note
- **Location:** `SECURITY.md`; invariant 7 in `docs/contributing/security.md`
- **Evidence:** Both say every data path is scoped by `userId` and that
  cross-user sharing is a bug. `AGENTS.md` describes orgs, teams, and cross-org
  grants, where sharing is the feature.
- **Recommendation:** Restate the invariant in terms of the one access check
  (`authorize`, ADR 0062) so researchers and agents test the real boundary.

---

## Part 2 — Engineering

### E1 — Desktop has no Electron fuses and forks with RunAsNode

- **Severity:** High · **Fix confidence:** Low
- **Location:** `packages/desktop/runner.cjs:20` (`ELECTRON_RUN_AS_NODE: '1'`,
  `fork(cli-host.cjs)`); `packages/desktop/package.json` (`"asar": false`); no
  `electronFuses` in `electron-builder.cjs` or `electron-builder.release.cjs`
- **Evidence:** No fuse configuration exists anywhere in `packages/desktop`. The
  app relies on `ELECTRON_RUN_AS_NODE` to host the CLI, so the RunAsNode fuse is
  on by default and in use. The app is unpacked, so there is no ASAR integrity
  check.
- **Impact:** Any process running as the user can execute
  `ELECTRON_RUN_AS_NODE=1 Kody -e '<code>'` (or use `NODE_OPTIONS` or
  `--inspect`) and run as the signed Kody binary. On macOS that inherits Kody's
  privacy grants (see D2). This is a known class of Electron issue.
- **Fix:** Host the CLI with `utilityProcess.fork` or a bundled Node binary.
  Then set fuses: `runAsNode: false`,
  `enableNodeOptionsEnvironmentVariable: false`,
  `enableNodeCliInspectArguments: false`,
  `enableEmbeddedAsarIntegrityValidation: true`, `onlyLoadAppFromAsar: true`,
  and turn `asar` on.
- **Why low confidence:** `cli-host.cjs`, auto-update relaunch, the packaged CLI
  test, and Windows and Linux builds all depend on the current fork. This needs
  a design pass and signed-build testing on three platforms.
- **Verify:** On a packaged build, run the command above and confirm it
  executes.

### E2 — `kody_session` lacks the `__Host-` prefix

- **Severity:** Medium · **Fix confidence:** Low
- **Location:** `setAuthSessionSecret` in
  `packages/worker/src/app/auth-session.ts` (cookie name `kody_session`)
- **Evidence:** The package-app session cookie already uses `__Host-` on secure
  requests (`packages/worker/src/app/package-app-session.ts`). The main session
  cookie does not. `api-docs`, `status`, `api`, and `nx-cache` are sibling
  subdomains of `kody.codes`.
- **Impact:** A script running on any sibling subdomain can set a
  `Domain=.kody.codes` `kody_session` and fix a victim into an attacker's
  account (the victim then saves secrets there). E15 and E18 are the weakest
  siblings today.
- **Fix:** Issue `__Host-kody_session` on secure requests. Read both names for
  one maximum session lifetime (30 days), preferring the prefixed one, then drop
  the old name.
- **Why low confidence:** Many readers and writers. `packages/desktop/main.cjs`
  matches the name `kody_session` when it copies the cookie after browser
  sign-in, and old desktop builds will keep doing so. E2E helpers and the OIDC
  logout path also name it.
- **Verify:** `rg "kody_session"` across `packages/` and `e2e/`.

### E3 — Axe gate covers 7 routes

- **Severity:** Medium · **Fix confidence:** Low
- **Location:** `e2e/a11y.spec.ts`
- **Evidence:** Scenarios: `/`, `/login`, `/signup`, a 404, `/account`,
  `/onboarding`, `/admin/users`. `packages/worker/start/routes` has about 290
  files. Only `critical` and `serious` impacts block.
- **Impact:** Every a11y item in this report and the last one came from reading
  source. Nothing automated guards packages, secrets, credentials, billing, org
  settings, the OAuth consent screen, docs, or community pages.
- **Fix:** Add the highest-traffic and highest-stakes routes first: OAuth
  authorize, `/connect/secrets`, secrets list, package detail and settings,
  billing, org people, docs article, community listing and detail.
- **Why low confidence:** Each route needs seeded fixtures, and the first run
  will surface violations of unknown size. Budget for triage.

### E4 — `COOKIE_SECRET` rotation is a hard cut

- **Severity:** Low · **Fix confidence:** Medium
- **Location:** `secrets: [secret]` in
  `packages/worker/src/app/auth-session.ts`; about 40 other consumers derive
  from `COOKIE_SECRET` (`rg COOKIE_SECRET packages/worker`)
- **Evidence:** One value signs sessions and is the root for package-app
  sessions, tickets, verification sessions, OAuth state, WebAuthn challenges,
  and unsubscribe links.
  [`secret-rotation.md`](../contributing/secret-rotation.md) documents that
  rotating it signs everyone out.
- **Impact:** Rotation after a suspected leak has a user-visible cost, which
  makes it less likely to happen.
- **Fix:** Accept an optional `COOKIE_SECRET_PREVIOUS`. Sign with the current
  value, verify against both. Remix `createCookie` already takes a list. The
  HMAC consumers need a shared `verifyWithEitherSecret` helper.
- **Verify:** Inventory the consumers first; some are short-lived and can stay
  hard-cut.

### E5 — Auto-update install runs scripts; Windows shell quoting

- **Severity:** Medium · **Fix confidence:** Medium · **Depends on:** D1
- **Location:** `npmInstall` (~590–612) and `runStep` (~540) in
  `packages/cli/src/execution-context/auto-update.ts`
- **Evidence:** The install passes
  `--no-save --no-package-lock --no-audit --no-fund --omit=dev` and no
  `--ignore-scripts`. On Windows it runs with `shell: true` and puts
  `input.prefix` and the tarball path on the command line unquoted.
  `packages/cli/package.json` uses caret ranges with no shrinkwrap.
- **Impact:** Lifecycle scripts of any transitive dependency run unattended on
  update. On Windows a home directory containing a space or `&` breaks the
  command or is parsed by `cmd.exe`.
- **Fix:** Add `--ignore-scripts` if `esbuild` and `@napi-rs/keyring` still work
  without their scripts (both ship prebuilt optional packages; the existing
  `kody version` smoke test will tell). Quote arguments for the Windows shell,
  or call `npm-cli.js` through `process.execPath` with no shell. Add
  `npm-shrinkwrap.json`.

### E6 — Focus rings vanish in forced-colors mode

- **Severity:** Medium · **Fix confidence:** Medium
- **Evidence:** No `forced-colors` or `prefers-contrast` rule exists in
  `packages/worker`. These sites set `outline: none` or `0` and draw focus with
  `box-shadow` or background only, both of which Windows High Contrast removes:
  - `start/commands/styles.ts:28` (command menu input)
  - `start/pages/account-avatar-editor.tsx:634`
  - `start/components/youtube-light-player.tsx:119`
  - `start/components/community-detail-sections.tsx:438` (report textarea)
  - `start/components/tabs.tsx:269`
  - `start/components/brand-context-menu.tsx:516` (background only)
  - `start/pages/community.tsx:257` (search input; check whether the wrapper
    draws a ring)
  - `universal/styles/style-primitives.ts:565` (heading anchors)
- **Impact:** Keyboard users in forced-colors mode cannot see where focus is
  (WCAG 2.4.7).
- **Fix:** Replace `outline: none` with `outline: 2px solid transparent` plus an
  offset. It is invisible normally and becomes a system-colored ring in
  forced-colors mode.
- **Verify:** Chrome DevTools → Rendering → emulate `forced-colors: active`. Add
  one Playwright check with `forcedColors: 'active'`.

### E7 — First-party pages miss COOP, Permissions-Policy, and CSP reports

- **Severity:** Low · **Fix confidence:** Medium
- **Location:** `packages/worker/src/app/security-headers.ts`
- **Evidence:** The header set is CSP, `X-Frame-Options`, `nosniff`,
  `Referrer-Policy`, HSTS. No `Cross-Origin-Opener-Policy`, no
  `Permissions-Policy`, and the CSP has no `report-to` or `report-uri`.
- **Impact:** CSP violations in production are invisible, so a broken or
  bypassed policy is found by users. No opener isolation on the consent screen.
- **Fix:** Add `Permissions-Policy` denying unused features (keep
  `publickey-credentials-get` for passkeys and `clipboard-write`). Add
  `Cross-Origin-Opener-Policy: same-origin-allow-popups`. Add CSP reporting
  through the existing `/sentry-tunnel` or Sentry's security endpoint.
- **Why medium:** `client/mcp-oauth-popup.ts` and social login use popups and
  redirects that COOP can break. Test those flows.

### E8 — DR control plane accepts any Access service token

- **Severity:** Medium · **Fix confidence:** Medium
- **Location:** `verifyAccessJwt` in
  `packages/backup-control-plane/access-auth.ts` (the `common_name` branch near
  the end)
- **Evidence:** A valid Access JWT with no `email` and any non-empty
  `common_name` is returned as the allowlisted operator. Human logins are pinned
  to `ACCESS_ALLOWED_EMAIL`; service tokens are pinned to nothing beyond the
  application audience.
- **Impact:** The Worker's own check adds nothing for service tokens. If the
  Access policy ever admits another token (a broad "any valid service token"
  rule, or a token minted for something else), it can drive backups and
  production restore.
- **Fix:** Add `ACCESS_ALLOWED_SERVICE_TOKEN_IDS` and require `common_name` to
  be in it. Fail closed when unset.
- **Verify:** Confirm which client ids the seal and drill automation use
  (`.github/workflows/dr-escrow.yml`, `tools/disaster-recovery/`).

### E9 — File-size ratchet guards an empty glob

- **Severity:** Medium · **Fix confidence:** Medium
- **Location:** `fileSizeRatchetGroups` in `tools/check-file-size-ratchet.ts`;
  `tools/file-size-ratchet.json`
- **Evidence:** The `client-routes` group budgets
  `packages/worker/client/routes/*.tsx` at 800 lines. That directory has zero
  `.tsx` files. Page components live in `packages/worker/start/pages` and
  `start/components`, where 17 non-test `.tsx` files exceed 800 lines
  (`execution-context-detail.tsx` 1880, `profiles.tsx` 1608,
  `oauth-authorize.tsx` 1190, `package-files-explorer.tsx` 1189,
  `org-subject-access.tsx` 1182, `connect-oauth.tsx` 1106,
  `desktop-execution.tsx` 1077). Worker source has no budget at all:
  `run-log-do.ts` 5347, `repo-session-do.ts` 5077, `package-app.ts` 4607,
  `universal/loader-data.ts` 3841, `tools/ci/resource-utils.ts` 3423.
  `*.workers.test.ts` is uncapped (`oauth-handlers.workers.test.ts` 2464), and
  three node tests sit at 1989–2000 against a 2000 cap.
- **Fix:** Point the group at `start/pages` and `start/components`, snapshot the
  current offenders, and add a `worker-src` group with a high cap (for
  example 2500) plus snapshot so the giants cannot grow. Add `*.workers.test.ts`
  to the test group.
- **Why medium:** The thresholds are a judgment call. Splitting the 5k-line
  Durable Objects is separate work; this item only stops growth.

### E10 — OFFSET paging and `LIKE` scans on list and search

- **Severity:** Low · **Fix confidence:** Medium
- **Location:** `queryMessageMetadataPage` in
  `packages/worker/src/email/mailbox-store.ts:775` (M4 residual: bodies are no
  longer selected, OFFSET remains); `listCommunityListings` and the search query
  in `packages/worker/src/community/repo.ts:653` and `:731` (`LIKE ?` per column
  plus OFFSET); 17 `OFFSET ?` sites in `packages/worker/src` overall
- **Impact:** Cost grows with page depth and table size. Community search is
  public. Fine at today's size; it is the first thing to hurt as listings grow.
- **Fix:** Keyset pagination on `(published_at, id)` and `(created_at, id)`;
  both orderings already include the tiebreaker. Move community search to FTS5
  or the existing Vectorize index when listing count warrants it.

### E11 — Desktop main process is untyped CommonJS

- **Severity:** Low · **Fix confidence:** Medium
- **Location:** `packages/desktop/*.cjs` (43 source files; `main.cjs` 774 lines,
  `execution.cjs` 564)
- **Evidence:** No `checkJs` for the package. `packages/status` already
  type-checks its browser JavaScript with `allowJs` + `checkJs`.
- **Impact:** The IPC and sign-in code that guards local command execution has
  no type checking in a repo that is otherwise strict.
- **Fix:** Add a `tsconfig.json` with `allowJs`, `checkJs`, `noEmit` and a
  `typecheck` target. Fix what it reports with JSDoc types. Converting to
  TypeScript is optional.

### E12 — Three compatibility dates across the fleet

- **Severity:** Low · **Fix confidence:** Medium
- **Evidence:** `2026-04-16` on origin, jobs, highlight, api, api-docs;
  `2026-07-22` on status, backup control plane, nx-cache; `2026-10-01` on
  platform, runtime, push-queue. Origin is held back on purpose: a comment in
  `packages/worker/wrangler.jsonc` says `2026-04-21` turns on
  `enable_python_external_sdk`.
- **Impact:** Workers that call each other run under different runtime defaults.
  The origin hold is seven months old.
- **Fix:** Check whether the Python SDK default can be opted out with a
  `no_`/disable flag, then advance origin to match platform and runtime. Add the
  dates to `tools/check-deploy-guardrails.ts` so drift is a choice.

### E13 — API edge rate-limit keys are caller-chosen

- **Severity:** Medium · **Fix confidence:** Medium
- **Location:** `forwardExecutionContextConnect` and `credentialRateLimitKey` in
  `packages/api-worker/src/edge.ts`
- **Evidence:**
  1. The WebSocket connect path returns before the general limiter and keys its
     own check on `ecp-connect:${ecid}:${ip}`, where `ecid` is the text before
     the first `.` in the caller's `ticket` query parameter. A new random prefix
     per request gets a new bucket, so one IP is never limited and every attempt
     reaches origin.
  2. The token limiter keys on `token:${parsed.tokenId}`, the public id parsed
     from an unverified bearer. Anyone who knows a token id can spend that
     token's 300 requests a minute with a garbage secret.
- **Fix:** For connect, also consume the plain `ip:${ip}` key. For tokens, key
  on a hash of the whole bearer (as the opaque-bearer branch already does), or
  on `tokenId` plus IP.
- **Verify:** Confirm origin validates the ticket cheaply before any Durable
  Object or D1 work.

### E14 — Account and admin navigation focuses `<main>`

- **Severity:** Medium · **Fix confidence:** Medium (carried from M9;
  re-verified open)
- **Location:** the pathname effect in
  `packages/worker/start/routes/__root.tsx:294`
- **Evidence:** Focus goes to `[data-docs-heading]`, else `#main`. Only docs
  headings carry the attribute.
- **Fix:** Put the attribute (renamed, for example `data-page-heading`) and
  `tabIndex={-1}` on the shared account and admin page-title component.
- **Verify:** Find the shared heading component first. If titles are rendered ad
  hoc per page this is wider than it looks.

### E15 — API docs CSP allows all of jsDelivr

- **Severity:** Medium · **Fix confidence:** Medium
- **Location:** CSP string in `packages/api-docs-worker/src/docs.ts:59`; script
  tag in `packages/api-docs-worker/src/page.ts`
- **Evidence:** `script-src https://cdn.jsdelivr.net`. jsDelivr serves any npm
  package and any GitHub repository, so the policy allows attacker-chosen
  scripts. SRI protects the one pinned tag, not the policy. Users paste API
  tokens into this page's request console.
- **Impact:** The CSP is no backstop against injection on `api-docs.kody.codes`,
  and that origin can plant cookies for `.kody.codes` (E2).
- **Fix:** Serve the pinned Scalar bundle from the Worker's own assets and set
  `script-src 'self'`. If the CDN stays, use a `'sha384-…'` hash source instead
  of the host.

### E16 — Password errors are not tied to their fields

- **Severity:** Medium · **Fix confidence:** High (carried from M10; re-verified
  open)
- **Location:** `packages/worker/start/pages/account-password-panel.tsx:243`
- **Evidence:** Errors and successes share one `<p role="status">`. Login and
  signup already use `fieldErrorProps`.
- **Fix:** Use `fieldErrorProps` (`aria-invalid` + `aria-describedby`) for field
  errors and `role="alert"` for failures. Apply the same to the `?oauthError=`
  text on login.

### E17 — UserMeter runs stale-row deletes on every consume

- **Severity:** Low · **Fix confidence:** High (carried from L5; re-verified
  open)
- **Location:** `deleteStaleCounters` in
  `packages/worker/src/entitlements/user-meter-do.ts:830`, called from nine
  consume paths
- **Evidence:** At least four `DELETE … WHERE day < ?` statements run on each
  execute, email, and fetch consume.
- **Fix:** Store the last cleanup day in memory and in Durable Object storage;
  skip when it equals today's UTC day.

### E18 — Status and DR pages send no security headers

- **Severity:** Medium · **Fix confidence:** High
- **Location:** `htmlResponse` in
  `packages/backup-control-plane/control-plane-ui.ts:875`; HTML responses in
  `packages/status/worker.ts:65`, `:115`, `:127`
- **Evidence:** Both set only `content-type` and `cache-control`. No CSP,
  `X-Frame-Options`, `nosniff`, or `Referrer-Policy` in either package.
- **Impact:** The DR control plane can start a production restore and can be
  framed. Its CSRF check (`assertSameOriginMutation`) only requires
  `Sec-Fetch-Site: same-origin`, which a click inside a framed copy of the page
  satisfies, so it does not stop clickjacking.
- **Fix:** Add `Content-Security-Policy` with `frame-ancestors 'none'`,
  `base-uri 'none'`, `form-action 'self'`, `default-src 'none'` plus what each
  page needs (both use inline style and script; add hashes or nonces),
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`.

### E19 — Authorize error page interpolates raw text

- **Severity:** Low · **Fix confidence:** High (carried from L3; re-verified
  open)
- **Location:** `standaloneAuthorizeErrorHtmlResponse` in
  `packages/worker/src/oauth-handlers.ts:206`
- **Fix:** HTML-escape `message` and pass the response through
  `applyFirstPartySecurityHeaders`.

### E20 — Resend-verification accepts any content type

- **Severity:** Low · **Fix confidence:** High (carried from L4; re-verified
  open)
- **Location:**
  `packages/worker/src/identity/account-resend-verification-operations.ts`
- **Fix:** Return 415 unless the request is `application/json`, per security
  invariant 10.

### E21 — `isSecureRequest` trusts client proto headers

- **Severity:** Low · **Fix confidence:** High
- **Location:** `getForwardedProto` and `isSecureRequest` in
  `packages/worker/src/app/auth-session.ts`
- **Evidence:** `Forwarded` and `X-Forwarded-Proto` are read from the request
  before `request.url`. On Cloudflare the URL is authoritative and a client can
  send either header.
- **Impact:** A client can make its own session cookie omit `Secure`. No
  cross-user effect.
- **Fix:** Use `new URL(request.url).protocol` only. If a local proxy setup
  needs the headers, gate them behind `isNonProductionRuntime`.

### E22 — Three 1.2–1.8 MB PNGs on error and signup pages

- **Severity:** Medium · **Fix confidence:** High
- **Location:** `packages/worker/public/images/kody-500-zapped.png` (1.78 MB),
  `kody-envelope.png` (1.17 MB), `kody-404-disappointed.png` (1.16 MB); used by
  `universal/internal-error-page.ts`,
  `start/pages/pending-verification.tsx:200`,
  `start/components/not-found-page.tsx`, and
  `start/components/package-no-access-page.tsx`
- **Impact:** Every new signup loads 1.17 MB on the "check your email" page.
  Every 404 loads 1.16 MB. The rest of the site already ships WebP.
- **Fix:** Re-encode to WebP or AVIF at display size with a 2x variant and
  `srcset`. Expect under 100 KB each. Keep the PNG only if email clients need
  it.

### E23 — Profile repository search has no accessible name

- **Severity:** Low · **Fix confidence:** High (carried from M8, the one part
  still open)
- **Location:** `packages/worker/start/components/profile-search-field.tsx:27`
- **Fix:** Add `aria-label="Search repositories"`.

### E24 — Stale axe exclusion on `/login` and `/signup`

- **Severity:** Low · **Fix confidence:** High
- **Location:** `exclude: 'a[aria-pressed]'` in `e2e/a11y.spec.ts:41` and `:50`
- **Evidence:** No anchor with `aria-pressed` exists in `packages/worker/start`.
  The comment names a "signup-gateway" owner that is no longer in the tree.
- **Fix:** Remove both exclusions and the comment. Run the spec.

### E25 — `client/routes/` holds no routes

- **Severity:** Low · **Fix confidence:** High (mechanical, wide diff)
- **Location:** `packages/worker/client/routes/` (62 non-test `.ts` modules of
  shared state and helpers, zero components);
  `packages/worker/start/legacy-contracts/` (22 test files)
- **Impact:** The name is a leftover from before TanStack Start and sends
  readers and agents to the wrong place. It is also why E9 went unnoticed.
- **Fix:** Move to a name that says what it is (for example
  `packages/worker/client/state/`), update the `#client/routes/*` imports, and
  move the legacy-contract tests next to the components they cover.

### E26 — Housekeeping bundle

- **Severity:** Low · **Fix confidence:** High
- `knip.ts` has no workspace for `packages/push-queue-worker`. Add it.
- `knip.ts` makes every file in `packages/shared/src` and `src/mcp/capabilities`
  an entry, so unused files and exports there are never reported. Narrow to real
  entry points if the false-positive rate allows.
- `.oxlintrc.json` turns off `typescript/no-explicit-any` and
  `no-warning-comments` for `packages/cli/**`. The CLI has one `any`. Remove the
  override and fix what surfaces.
- `patches/wrangler+4.147.0.patch` (startup profile timeout 10s → 60s) is not
  mentioned in any doc. Add it to
  [`dependency-overrides.md`](../contributing/dependency-overrides.md), and add
  a short index of all six patches there; today they are described across four
  files.
- 19 links still point at `github.com/kentcdodds/kody` (mostly decision records
  and `disaster-recovery.md`). They redirect; update to `kody-hq/kody`.
- Workflow actions are pinned by tag (`actions/checkout@v6.0.2`,
  `actions/setup-node@v6`, `upload-artifact@v4`, `download-artifact@v4`,
  `cache@v5.0.3`). Seven `github-script` uses are pinned by SHA and one is
  `@v8`. Pin all by SHA; `deploy.yml` holds every production secret.
- `.github/workflows/preview-rehearsal.yml:77` sets `REHEARSAL_PASSWORD_KEY`
  from `secrets.CLOUDFLARE_API_TOKEN`. Give it its own secret so rotating the
  API token does not change derived passwords and the token is not key material.
- `packages/cli` depends on `esbuild ^0.25.12`; the root uses `^0.28.2`. Align
  or record why.

---

## Status of the 2026-09-16 findings

| ID  | Status today                                                            |
| --- | ----------------------------------------------------------------------- |
| H1  | Fixed (invariant 15: adoption is session-only)                          |
| H2  | Fixed (no secret-authority symbols left in `runtime-source-modules.ts`) |
| H3  | Fixed                                                                   |
| M1  | Partly addressed by `requiresLivePerson`; see D3                        |
| M2  | Open; see D6                                                            |
| M3  | Open; see D5                                                            |
| M4  | Bodies no longer selected; OFFSET remains; see E10                      |
| M5  | Fixed (`loadIsomorphicGit`)                                             |
| M6  | Not re-verified (markdown stack changed on 2026-10-28)                  |
| M7  | Open; see D10                                                           |
| M8  | Fixed except profile search; see E23                                    |
| M9  | Open; see E14                                                           |
| M10 | Open; see E16                                                           |
| M11 | Fixed (`aria-busy`, list kept)                                          |
| L1  | Not re-verified (handler no longer calls `formData()` directly)         |
| L2  | Open; see D7                                                            |
| L3  | Open; see E19                                                           |
| L4  | Open; see E20                                                           |
| L5  | Open; see E17                                                           |
| L6  | Open; see D12                                                           |

## Checked and found sound

So the next reviewer can skip these:

- **SQL:** all 30 non-test files that interpolate into SQL text use constants,
  typed unions, or quoted identifiers. No user input reaches SQL text.
- **HTML sinks:** three `innerHTML` / `dangerouslySetInnerHTML` sites, none fed
  by user content. No `eval` or `new Function` in product code.
- **Token storage:** password-reset tokens, org invite links, and API tokens are
  stored as SHA-256 hashes and generated with `crypto.getRandomValues`.
- **Stripe webhooks:** constant-time signature compare with a timestamp
  tolerance.
- **Raw package files:** `default-src 'none'; sandbox`, `nosniff`, sanitized
  `Content-Disposition`.
- **Rate limiting:** credential endpoints share the `auth:ip` bucket; about 30
  call sites cover reset, 2FA, device flow, invites, and guests.
- **Workflows:** the two `pull_request_target` workflows check out only the base
  ref; event data reaches scripts through `env`, not inline expressions; default
  permissions are read-only.
- **nx-cache:** constant-time token compare, write-once objects, separate read
  and write tokens.
- **Desktop window settings:** `sandbox`, `contextIsolation`, no
  `nodeIntegration`, navigation allowlist, origin-checked preload bridge.
- **N+1 queries:** loops that touch D1 are chunked batches.

## Coverage and limits

- Nothing was executed. No `npm run validate`, no axe run, no browser, no
  packaged desktop build, no proof-of-concept for any security item.
- Not reviewed in depth: the capability-by-capability authorization matrix,
  `package-app.ts`, `run-log-do.ts`, `repo-session-do.ts`, the fetch gateway,
  credential stamps, billing logic, the 235 D1 migrations and index coverage,
  blog content, the 2,000 test files (quality, not count), and dependency CVEs.
- Usability was not assessed beyond source patterns. No native
  `confirm`/`alert`, few generic error strings, and consistent `autocomplete`
  hints were found; real usability review needs the running app.
- Client bundle size and Worker startup were not measured.
- False-positive risk is highest on E1 (assumes default fuses in the pinned
  Electron), E2 (needs a sibling-origin script to matter), E8 (depends on the
  Access policy, which is not in the repo), and E13.1 (depends on what origin
  does before rejecting a bad ticket).
