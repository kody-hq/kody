# Private deployment smoke checks

`private-smoke.ts` reuses `control-kody`'s exported login and session request
helpers. It reads fixture credentials and Access headers from private files,
keeps the application session in memory, and emits only path, status and pass
flags. Access tokens and the session cookie go only to the selected exact HTTPS
origin. Redirects are rejected instead of followed with credentials.

Run after paired performance measurements finish, once per deployed origin:

```sh
node tools/framework-comparison/private-smoke.ts HTTPS_ORIGIN /tmp/kody-private-access/headers.json /tmp/kody-private-deployment/test-accounts.json
```

Checks use existing fixture data. They read homepage, pricing and docs as an
anonymous application user, sign in through the product's `/auth` endpoint,
verify the account profile belongs to the fixture, read account and connections
HTML, then read the same profile again. A separate anonymous profile request
must return 401 without the fixture's identity. No profile writes, email,
billing, packages, seeds or resource changes occur.

This is an HTTP smoke check. It does not prove that client navigation preserves
state, that a second user's account is isolated, or that focus revalidation
shows a recent mutation. The supplied file contains one fixture identity. A
second independently provisioned user is needed for a cross-user check.

For the later browser pass, use the same private origin and fixture. Exercise
account to connections to account and Back/Forward, watching for document
reloads and blank main content. Test two-tab freshness with a reversible display
name edit only after that mutation is authorized, then restore the original
value. Keep Access credentials origin scoped on every request, including
redirects. Do not use the anonymous Lighthouse interceptor unchanged: it strips
application cookies by design. Do not point the local Playwright E2E suite at
the deployments. Follow the repo's control-kody and preview-manual-test workflow
for sessions and product API assertions.

The adapter has a mocked test for same-origin session preservation and rejected
cross-origin/redirect transport. Live checks and this test have not been run
while the paired edge benchmarks are active.

## Browser journey

`private-browser-smoke.mjs` uses Puppeteer from the same installed Lighthouse
package directory. It is a dedicated preview journey, not the local Playwright
suite. Run only after the paired audits finish and the operator gives GO:

```sh
node tools/framework-comparison/private-browser-smoke.mjs HTTPS_ORIGIN /tmp/kody-private-access/headers.json /tmp/kody-private-deployment/test-accounts.json LIGHTHOUSE_PACKAGE_DIRECTORY NEW_OUTPUT_JSON --allow-profile-mutation
```

It requires private credential-file permissions, a configured exact origin and a
fresh report path. It signs in through both the browser UI and the repo CLI
helper. The separate CLI session provides authoritative profile checks and
restoration if the browser journey fails. Browser request interception preserves
same-origin cookies, injects Access tokens only on that origin, and strips
credentials on third-party requests. Cross-origin document navigation is
blocked.

The browser journey checks account/connections navigation and Back/Forward
without document reload or empty main content. It changes only the disposable
fixture's display name, verifies persistence through the CLI, refreshes a second
tab, and checks that an unsaved draft survives another update. The original
visible display name is restored and read back before logout. On failure,
cleanup restores only a value matching this run's marker, so it does not
silently overwrite an unrelated concurrent edit.

Logout must deny the profile API without revealing fixture identity, and the
other tab must reach login when it reopens account. This is same-session logout
isolation, not a second user's account-isolation test. The harness records
whether actual browser activation delivered focus or explicit event simulation
was necessary. It writes only named boolean checks and counters, never account
values, cookies, headers, raw errors, screenshots, HARs or traces.

The final deployed candidate passed all 16 journey checks with zero browser
errors and the original display name restored. Actual browser activation
delivered focus, no event simulation was used. The raw candidate report is local
experiment output, not a checked-in artifact. The baseline passed 15 of 16
checks. Its second tab did not receive the changed profile on browser focus,
while navigation, history, mutation, restoration and logout checks passed. It
had zero browser errors. The failed freshness assertion remains a failure even
though the harness continues independent checks. The raw baseline report is also
local-only. These historical results do not validate the current PR preview.

The harness uses an explicit desktop viewport, visible account navigation,
completed hydration, and activates the relevant tab before editing. Earlier
reports document harness selector and background-tab failures, not application
regressions. It does not establish every account/admin feature or external
integration works, and a failure remains a failure even if cleanup succeeds.

Navigation motion checks also remain required before claiming visual parity. See
[Navigation motion review](./NAVIGATION-MOTION-REVIEW.md) for the original
selective policy and supported Router hooks. Add fresh-home versus return-home
entrance checks, docs guide transitions, reduced motion, and rapid superseding
navigation. The prepared account harness does not yet measure those animations.
