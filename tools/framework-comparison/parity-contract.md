# Full web app migration parity contract

Inspection baseline: `8b2528460eb9be9d08d50b7a1d2ee8f491503d83`. This is an
acceptance plan with scoped results recorded in the evidence section below.
Unchecked items are not blanket passes, even when a related E2E test passes.
Migration means the public site, authenticated app, admin app, authentication,
and onboarding. Existing Worker APIs, user isolation, package hosting, and
protocol endpoints must continue working.

The candidate now uses Redact. Earlier React-runtime passes below do not
establish Redact parity. SVG hydration has a regression-tested dependency fix;
error-boundary and document replacement also have regression-tested fixes. All
29 native browser tests pass after a two-factor response-order fix. The
intermittent pre-click form disappearance was subsequently reproduced as a Vite
dependency-discovery document reload and fixed with explicit client prebundling.
Three independent cold starts passed without retries. The detailed cold-start
and runtime reports are local experiment output, not checked-in evidence for the
current revision.

No finite test suite establishes 100% correctness. A defensible parity claim
names the revision, routes, fixtures, browsers, checks, and limitations that
were tested. Unknown defects are investigation targets, not promised fixes.

## Inventory and evidence

Use `packages/worker/universal/routes.ts` as the route authority, with
`tools/control-kody/feature-catalog.ts` and each feature's guide under
`.agents/skills/control-kody/references/features/` as the behavior inventory.
The catalog covers whole route families by prefix, so a passing map check is not
proof that each child route was tested. Expand parameterized routes using real
seeded IDs. Include HTML, JSON, redirects, raw files, icons, downloads, OAuth
callbacks, and non-HTML endpoints. Preserve HTTP methods and statuses.

Run `npm run control-kody -- map --check` and `npm run validate` against both
revisions. Existing browser tests are useful independent behavioral evidence; do
not weaken them to fit the new framework. Framework-specific unit tests may need
replacement, but their behavior assertions still belong in this contract. Do not
count a passing backend suite as proof that the migrated UI works.

For each row below, record baseline and migration status, fixture identity,
request/trace evidence, and any accepted difference. Use anonymous, ordinary
user A, ordinary user B, and an admin. Existing seed users are not admins; local
`kody@example.com` is the documented admin fixture. Use isolated test records.
Actual billing charges and external mail are unnecessary.

## Route and behavior matrix

| Surface                      | Routes / actions to exercise                                                                                                                                  | Existing browser evidence                                                                                  | Extra acceptance work                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public site                  | `/`, `/pricing`, `/faq`, `/case-studies`, `/support`, `/privacy`, `/terms`, `/discord`                                                                        | `smoke.spec.ts`, `faq.spec.ts`, `support.spec.ts`, `a11y.spec.ts`                                          | Logged-out SSR and hydrated content, native FAQ disclosures, media overlay close/history, links and structured metadata                                                               |
| Docs and blog                | `/docs`, each docs slug, `/guides` redirects, `/blog` and article URLs                                                                                        | `docs.spec.ts`                                                                                             | Direct deep links, unknown slug 404, sidebar selection, article anchors, next/previous, search, encoded slugs, SSR and client head parity                                             |
| Discovery and packages       | `/community`, `/@:username`, `/@:username/:kodyId`, settings, publish/change approval, raw files and icons                                                    | Feature guides `community.md`, `packages.md`                                                               | Filters/search/pagination, install/report/trust/feature, owner vs visitor vs shared access, missing/private package, files and preview, publish status                                |
| Signup and verification      | `/signup`, `/pending-verification`, `/verify-email`, email change/claim release/destination verification, `/unsubscribe/tips`                                 | `signup-verify-connect.spec.ts`                                                                            | Real mock-email token journey, invalid/expired/reused tokens, resend feedback, redirect target and account state                                                                      |
| Sign in and recovery         | `/login`, `/auth`, `/session`, `/logout`, social callbacks, `/reset-password`, reset endpoints                                                                | `smoke.spec.ts`, `social-login.spec.ts`                                                                    | Wrong credentials, preserved safe return URL, password reset via mail, invalid token, logout shell refresh, expired session on navigation and mutation                                |
| Strong authentication        | `/verify`, `/account/two-factor`, `/account/passkeys`, WebAuthn endpoints                                                                                     | `two-factor.spec.ts`, `passkeys.spec.ts`                                                                   | Existing enable/sign-in/disable lifecycle, recovery and errors, browser WebAuthn cancellation, verification gates                                                                     |
| Onboarding and connections   | All `/onboarding` steps and agent/service children; `/account/connections` and new/agent children                                                             | `signup-verify-connect.spec.ts`, `account-navigation.spec.ts`                                              | Back/forward, selected agent persistence, checklist completion/dismissal, current session, deep-link and reload parity                                                                |
| Account identity             | `/account`, profile/avatar/email/password/export, `/account/delete`                                                                                           | Feature guide `account.md`                                                                                 | Validation and server errors, multipart upload, download headers, email verification, deletion confirmation, owner-only effects                                                       |
| Secrets and integrations     | `/account/secrets`, secret providers/approval, `/connect/secrets`, `/account/integrations`, `/connect/oauth`, MCP servers and OAuth clients                   | Feature guides `secrets.md`, `integrations.md`, `mcp-servers.md`                                           | Create/edit/revoke, scope/host/package restrictions, one-time secret values, approvals, OAuth state/PKCE and callback errors                                                          |
| Automation                   | Jobs, workflows, webhooks, webhook apply/approval                                                                                                             | Feature guides `jobs.md`, `workflows.md`, `webhooks.md`                                                    | Create/edit/pause/run/delete where offered, schedule/timezone, run feedback, webhook rotation and overlap, approval ownership                                                         |
| Personal data                | Activity, waiting, experiments, shared packages, memories, email, values                                                                                      | `account-navigation.spec.ts` and corresponding feature guides                                              | Search/filter and focused input continuity; create/update/delete where supported; export; approve/reject; unread/status changes; fixture values survive reload                        |
| Billing                      | `/account/billing`, `/account/credits`, `/account/usage`, checkout/top-up/settings/cancellation APIs                                                          | Credits redirect in `account-navigation.spec.ts`                                                           | Credits redirects to usage, plan/entitlement UI, usage period, mocked checkout/portal return, server-side permission and amount validation                                            |
| Administration               | `/admin`, users and user detail, roles, reserved usernames, flags, banners, integrations, provider marks, codemods, reports, insights, feedback, system email | `admin-rbac.spec.ts`, `admin-feature-flags.spec.ts`, `admin-banners.spec.ts`, `account-navigation.spec.ts` | Each section deep-link and CRUD/action where present, role revoke during session, target-user isolation, grant audit record, destructive confirmation, ordinary-user HTML and API 403 |
| Unchanged platform contracts | `/health`, assets, MCP/Open API, package apps, Git/raw routes, webhooks, auth protocol endpoints                                                              | Existing worker/node/MCP tests via validate                                                                | Route precedence, content types, cookies, request bodies, CORS and redirects unchanged; hosted author content retains its separate security boundary                                  |

Rows without browser evidence need HTTP/API checks plus a representative browser
journey, not a separate browser test for every control. Prefer existing broad
journeys and fast request or unit checks for edge cases.

## Navigation and data freshness

The baseline already loads data and lazy modules before committing the next
page. Its bar is not simply “SPA navigation works.” See
`docs/contributing/no-flash-navigation.md`, `client-router.tsx`,
`route-data.tsx`, `navigation-data.ts`, and `intent-prefetch.ts` in
`packages/worker/client/`.

- [ ] Slow docs, account, admin, and package navigation keep the old complete
      page until the new page is ready. Observe `<main>` with the existing
      `e2e/main-transitions.ts` helper. No blank main, missing heading,
      duplicate article, intermediate loading copy, or layout shift from
      replacing content.
- [ ] SSR payload is used during hydration. Warm navigation consumes prefetched
      data without fetching the same payload again. Count requests, including
      redirects, before and after the click; do not hide prefetch work from
      totals.
- [ ] Hover, keyboard focus, touch, render prefetch, expired prefetch, and no
      prefetch all reach the correct destination. Different docs slugs never
      share article payload merely because they share a route matcher.
- [ ] A slow A navigation followed by faster B ends at B, including URL, title,
      content, focus, and scroll. Late A success/error/redirect cannot win.
      Repeat with Back, hash navigation, and a mutation response in flight.
- [ ] Same-URL mutation redirects reload current data. A mutation invalidates
      prefetched affected data and shell/session data. Test direct JSON
      mutations as well as router-handled form POSTs.
- [ ] Mutation UI settles only with server-confirmed state or explicitly
      reconciles optimistic state. Failure restores usable inputs and
      communicates an error. Double-clicking does not create duplicate records.
- [ ] User A logout then user B login cannot show A's cached SSR, loader,
      prefetch, query, shell, or frame data. A permission change takes effect on
      the next protected request, even if old data was prefetched.
- [ ] Change data in another tab and through an API, then revisit/focus/reload.
      Record the observed stale interval for jobs, activity, waiting, email,
      credits, and role changes. Set an explicit freshness policy per surface; a
      framework's default stale time is not a product requirement.
- [ ] Route errors distinguish missing data, forbidden access, expired session,
      server failure, and network failure. Retry is usable. Failed module loads
      after a deployment recover without an infinite reload loop.

Existing fast evidence includes `client-router.node.test.ts`,
`client-router-recovery.node.test.ts`, `route-data.node.test.ts`,
`route-load-latch.node.test.ts`, and `intent-prefetch.node.test.ts`.

## History, document, and forms

- [ ] Push, replace, Back, Forward, direct load, reload, encoded hash, and
      same-path query changes preserve URL and content agreement. Repeating a
      hash link scrolls to the target. Back restores its history entry's scroll.
- [ ] Account/admin/docs shells remain stable. Search keeps the same focused
      input and caret as results change. Reduced-motion disables transitions.
- [ ] Client navigation updates title, description, canonical, robots, OG and
      social metadata from destination data. Compare with a fresh SSR request to
      that exact URL. Errors must not retain another article's metadata.
- [ ] Native modified clicks, download links, external links, targets, and
      non-HTTP links retain browser behavior.
- [ ] Forms preserve submitter name/value and its action/method/target/enctype
      overrides; GET search encoding; multipart files; validation errors; and
      accessible pending/success/error feedback. Do not silently discard a valid
      non-redirect error response.
- [ ] Document redirects preserve appropriate 3xx status and cookies. Private
      API failures remain JSON/status failures rather than login HTML
      masquerading as successful JSON.

Native scroll restoration is configured in `packages/worker/start/router.tsx`
with `scrollRestoration: true` and instant restoration. Router owns restoration;
the old inline scroll script and its CSP hash have been removed.

Related regression sources are
`packages/worker/start/components/native-document-head.node.test.ts`,
`packages/worker/start/navigation-motion.node.test.ts`, and
`packages/worker/start/site-link.native.node.test.ts`. These cover metadata,
transition policy, and link semantics. They do not establish browser scroll
restoration parity; verify back/forward positions and focus in the browser.

## Frames, security, caching, and rendering

- [ ] Preserve community listings/details and every registered frame's visible
      behavior, including frame GET forms, URL/history, reload, auth, and
      errors. Replacing a frame with a component still requires equivalent
      behavior.
- [ ] Frame requests never receive cached full documents or nest another shell.
      Honor existing `x-remix-target` / `__frame` contracts while they are
      supported, or explicitly remove all callers and tests as part of an
      intentional change.
- [ ] Private pages and user-scoped fragments cannot enter anonymous browser,
      Worker, or edge caches. Compare headers and bodies for anonymous, A, and B
      requests to the same URL, including query/header variations.
- [ ] Keep first-party CSP protection in `src/app/security-headers.ts`, notably
      no blanket `script-src 'unsafe-inline'`. Start hydration/streaming scripts
      need a deliberate compatible nonce/hash design. Verify actual browser CSP
      violations, not only header string presence.
- [ ] Preserve cross-origin mutation protection from
      `src/app/cross-origin-protection.ts`, secure session cookie settings, safe
      redirects, permission checks, and per-request user isolation. New server
      functions must enforce the same rules as existing APIs.
- [ ] Malicious text in profile names, search, markdown, JSON hydration
      payloads, filenames, and errors remains escaped across SSR and hydration.
- [ ] With JavaScript disabled, public content, links, docs, legal/support
      pages, and native forms retain their current usable behavior. Record
      existing JS-only controls explicitly, do not claim new no-JS parity
      without testing.
- [ ] SSR HTML status, semantic content, links, canonical/robots metadata,
      sitemap/feed endpoints, and redirect chains remain crawlable. No hydration
      warnings, missing SSR content, or permanent pending state.
- [ ] Run existing axe journeys in both themes. Check keyboard navigation, focus
      after navigation/dialog close, labels, error association, live status,
      heading order, contrast, reduced motion, and small-screen overflow
      manually.

Evidence: `docs/contributing/no-flash-navigation.md`, native navigation tests,
anonymous HTML cache node/worker tests, cross-origin-protection tests, and
`e2e/a11y.spec.ts`. Paths above beginning `src/` are under `packages/worker/`.

## Concrete baseline bug candidates, unverified

These are code-inspection hypotheses. Reproduce on the baseline first, then
record a test and before/after evidence before calling anything a bug fix.

1. **A non-redirect form failure may be silent.** `client-router.tsx:947`
   intercepts form submissions; after a response without a redirect or Location
   it throws, and its catch logs to the console and ends navigation without
   rendering the response's error body. Reproduce with an intercepted ordinary
   form whose server returns 400/422/500 without redirect. Determine whether any
   actual form currently reaches this path.
2. **Direct JSON mutations may leave prefetch data stale.** `intent-prefetch.ts`
   permits settled payload reuse for 30 seconds. The router clears speculative
   data for intercepted form POSTs, but account secrets saves use their own JSON
   fetch in `routes/account-secrets.tsx:321`. The inspected prefetch module has
   no general mutation subscription. Prefetch an affected destination, save via
   a direct JSON handler, then navigate away and back within 30 seconds. Check
   whether old values return. Scope depends on each route's own reconciliation
   and prefetch eligibility.
3. **Dynamic head recovery after loader failure needs verification.** The
   router's loader-failure catch applies the destination head with no loader
   data, then route-data may recover via a fallback fetch. Verify a
   docs/blog/profile destination whose first loader fails and second succeeds:
   does the eventual title/canonical reflect recovered data? The observed router
   sequence alone does not prove a defect elsewhere in the app.

## Release decision

Require all critical functional/security rows to pass on the migration,
`npm run validate` to pass, and a deployed preview check with real bindings. The
supported E2E storage mock can persist repository fixtures, but local success
cannot verify real deployed storage, publishing, or provider behavior. Preserve
traces and exact commits for failures and fixes. A blocked or skipped case
remains a limitation, never a pass.

Compare production builds under the same browser, region, data, cache state, and
CPU/network settings. Measure cold load and warm multi-page journeys,
request/byte totals including prefetch, click-to-ready latency, data age after
mutation, Web Vitals, Lighthouse accessibility/SEO/performance, bundle/Worker
size, build/typecheck time, changed source size, and duplicated routing/cache
logic. Repeat samples and report distributions and variance. Lighthouse's single
document score cannot establish multi-page speed or data correctness.

A good migration needs measured benefits without critical regressions. If the
result is slower, more complex, or incompletely verified, report that result
instead of treating a framework switch as proof of improvement.

## Candidate implementation evidence, October 8

The candidate renders native React from structured backend payloads. Loaders
reuse existing authorization services or invoke JSON handlers in process. This
is evidence for specific behavior, not a guarantee of complete parity.

The original-app E2E stage of the final authoritative validation finished with
18 passes and 2 failures in newly added shared tests: the document contract and
private-package acceptance freshness. The latter is independently traced below.
The final corrected native suite passed all 21 tests in 2.2 minutes without
retries, after the billing completion migration. Full repository typechecks also
passed. The original failures mean the authoritative combined `npm run validate`
gate is not a clean pass. Native test success establishes the specific journeys
below, not every unchecked acceptance item.

| Surface                  | Verified evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Remaining checks                                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private packages         | `e2e/package-access.spec.ts` passed against native Start with actual repository files stored by the supported Cloudflare mock. Owner navigates Files, README and Settings without document reload. Lock persists after reload. UI invite, guest acceptance, source reading and revocation work. Stranger and anonymous HTML/JSON omit a unique private source marker. Accepted guests get settings 404 and cannot lock another user's package. Revoked guests lose source access while the owner retains access. | Real deployed storage, publish approval, ref/history/media, visibility changes, adoption, webhook reveal/rotate/disable, same-path file updates, deletion failure/retry and non-empty public catalog.                                                       |
| Account freshness        | `e2e/start/freshness.spec.ts` passed: two tabs for user A, separate user B, real UI saves, fresh server payload after a focus event, back/forward navigation, no document reload, dirty draft preservation and account isolation.                                                                                                                                                                                                                                                                                | The focus event is explicitly delivered by the test because Playwright Chromium emitted no activation events in headless or headed probes. Real operating-system tab activation timing and hidden-tab visibility sequencing still need manual verification. |
| Admin access and privacy | Existing RBAC E2E passed: ordinary users cannot read admin screens/usage; admin views do not expose another user's seeded secret; role assignment persists.                                                                                                                                                                                                                                                                                                                                                      | Provider-mark create/edit/logo/delete, insights chart accessibility and data accuracy under real metrics, revoked roles during active sessions.                                                                                                             |
| Authentication           | Existing signup/email-verification/connect, social login, passkey and two-factor E2E cases passed in the completed run.                                                                                                                                                                                                                                                                                                                                                                                          | These use local fixtures and supported mocks. Real provider callbacks, credentials, token exchange, replacement confirmation, callback replay, external outages and deployed cookie/domain behavior remain separate gates.                                  |
| Public pages/docs        | HTTP checks passed for blog, docs index, guides and connect catalog, including missing-doc 404. Docs navigation E2E passed its no-loading-flash checks. Native no-JavaScript home/pricing/FAQ/docs/privacy render complete documents with headings, footer and title. Home discovery headers, missing-doc and case-sensitive 404, explicit 500 and unsupported POST 405 passed.                                                                                                                                  | Full blog/community content fixtures, responsive visual comparisons, transcript/clipboard details, metadata/history/scroll matrix and no-JavaScript checks beyond the sampled pages.                                                                        |
| Onboarding               | Native HTTP checks cover step 1 and a selected host. Signup verification reaches MCP connect in E2E.                                                                                                                                                                                                                                                                                                                                                                                                             | Real first/second-agent grant arrival, polling races, hidden-tab resume, popup completion, remembered choices and progress celebrations.                                                                                                                    |
| Accessibility            | Existing axe test passed for home, login, signup, not-found, account, onboarding and admin users in light/dark themes, checking critical/serious violations.                                                                                                                                                                                                                                                                                                                                                     | This is not a complete accessibility audit. Existing test exclusions on login/signup and lower-impact findings remain outside its claim. More admin/package screens, keyboard behavior and manual assistive-technology review remain.                       |
| Legacy package URLs      | Native loaders retain canonical redirect behavior. Four targeted regression tests pass for accepted-share settings denial, unauthorized HTTP 401, and moved-package query/status/cache behavior.                                                                                                                                                                                                                                                                                                                 | Deployed response headers and a stale canonical-pair fixture.                                                                                                                                                                                               |
| Build/maintenance        | Final full repository typechecks passed. Focused lint and full Knip passed during development.                                                                                                                                                                                                                                                                                                                                                                                                                   | Final authoritative `npm run validate`, production build/deployed smoke, measured bundle/worker size, build time and maintenance comparison must use the final commit.                                                                                      |

The earlier plain dev-server package-create attempt failed because it lacked
ARTIFACTS or Cloudflare API credentials. The supported E2E server supplies mock
API credentials and source snapshots, and the private-package test then passed.
This closes the local fixture gap, not the real-service deployment gap.

Concrete migration defects found and corrected include the shared-viewer
settings guard, unauthorized package HTTP status, moved URL query/status
handling and stale approval payload state. The package regression tests and
package E2E support the access-control fixes. The OAuth callback component now
keeps its identity while scrubbing the callback query so an observed history
replacement cannot unmount an in-flight token exchange. That fix still needs a
complete real-provider callback test.

### Verified baseline freshness defect

The shared `e2e/package-access.spec.ts` reproduced an original-app defect on
both attempts in the authoritative validation run. After a guest accepts a
private package share, the POST succeeds and the status changes to accepted, but
the original page keeps its pre-acceptance content. The trace contains no
subsequent guest detail, frame or README request. Its failure snapshot shows all
three at once:

- The title area still says the guest has been invited.
- The status says the package is shared with the guest as use/follow.
- The README area says the package has no README, despite the actual fixture
  README containing the private source marker.

The original `submitShareAccept` updates only `shareGrant` and calls
`handle.update()` at
`packages/worker/client/routes/community-detail.tsx:348-349`. It does not reload
the source payload. The candidate invalidates the router after acceptance at
`packages/worker/start/pages/community-detail.tsx:235`, and this same package
test passes, including the immediate README assertion, source read,
owner-settings denial, revocation and subsequent source denial. This is a
verified data-freshness improvement in the tested local fixture, not a blanket
claim about all shares.

Evidence: `/tmp/kody-final-validate.log`, failure at
`e2e/package-access.spec.ts:160`; retry trace under
`test-results/package-access-private-pac-2933f-er-and-anonymous-navigation-chromium-retry1/trace.zip`.
The retry owner fetched files at 18:02:05.273 UTC and detail at 18:02:05.433
UTC; both returned 200 and contained the fixture marker. The owner invited the
guest at 18:02:08.137 UTC. The guest's acceptance POST returned 200 at
18:02:08.564 UTC with an accepted use/follow grant, and the captured error
context retained the stale README. These timestamps are October 8, 2026, from
the trace network log. The contradiction is visible in the adjacent
`error-context.md`. It establishes stale content after an accepted grant, not
broken backend share permissions. The test uses supported mock-backed repository
persistence, not hand-authored package database rows.

Potential pre-existing improvements are kept separate from verified fixes:

- The original files explorer caches rendered content using path identity. The
  candidate memoizes by complete loader data. Updating a same-path file and
  comparing both versions is still required.
- The original provider-mark editor disables the slug field but reads it from
  FormData, which excludes disabled inputs. The candidate uses the selected
  slug. A before/after browser test remains.
- The original provider-mark logo read can complete after selecting another
  mark. The candidate aborts old reads and checks a revision before accepting
  results. A controlled before/after race test remains.

Performance and Lighthouse results belong to a matched production comparison.
Neither passing tests nor switching frameworks proves that the migration is
faster, simpler, or a good deployment choice.
