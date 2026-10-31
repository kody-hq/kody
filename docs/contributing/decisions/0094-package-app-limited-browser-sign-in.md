# 0094: Package-app visitors sign in from limited browsers

- **Status:** accepted
- **Date:** 2026-10-31
- **Amends:** [0082](./0082-cli-oauth-device-authorization-grant.md)

## Context

Package-app visitors sign in through Kody's `/login` and the package-app consent
page. Both needed the page's app JavaScript: the submit button stayed disabled
until hydration and Turnstile was drawn by the app bundle. Browsers that cannot
run that bundle (for example an e-reader on Chromium 80) could not sign in, so
they stayed signed out of the app.

## Decision

1. **Plain HTML first.** `/login` and `/verify` (two-factor) accept a normal
   `application/x-www-form-urlencoded` POST and answer with a 303 redirect,
   never JSON. They run the same operations, the same per-IP auth rate limit
   (origin handler), the honeypot, and Turnstile (the two-factor step checks the
   honeypot and Turnstile too, before the per-account guess budget). Same-origin
   is required (`Origin`, then `Sec-Fetch-Site`, then `Referer`). Failures come
   back as a `?formError=` code, never server text. Modern browsers keep the
   in-page submit. A classic ES5 script (`public/auth-fallback.js`) draws
   Turnstile when the app never hydrates. Turnstile is not bypassed: with
   JavaScript fully off it cannot be solved, so the `<noscript>` note sends
   those visitors to Sign in on another device. Passkeys and social sign-in
   still need JavaScript; the note says so. The consent page was already a form
   POST; its "Choose another credential" toggle is now a native `<details>`.
   `styles.css` adds sRGB fallbacks for browsers without `oklch()`.
2. **Sign in on another device.** When `/login` is resuming a package-app
   authorize request it offers "Sign in on another device". That reuses the 0082
   device-code machinery (`oauth_device_authorizations`, user codes, 10 minute
   lifetime, single use, code-entry limits on `/device`) with
   `kind = 'package_app'` rows. The row stores the validated authorize request
   (client, `redirect_uri`, state, PKCE challenge, the asking browser's label).
   The device code lives only in an HttpOnly cookie on the limited browser. Its
   page shows the user code, a server-drawn QR code for `/device?user_code=…`,
   and refreshes with an HTTP `Refresh` header.
3. **Approve on the app's consent page.** `/device` sends package-app codes to
   `/oauth/package-app/authorize?device_user_code=…`, which builds the request
   from the row (never the query), always shows consent, and adds the code and
   the asking browser. Allow records the grant exactly like a normal consent;
   Deny shares nothing. The CLI token endpoint and `/device` approve refuse
   these rows.
4. **Same session.** On its next check the limited browser consumes the approved
   row once and receives an ordinary package-app authorization code for its own
   `redirect_uri` and PKCE challenge. The app host's callback then sets the
   usual per-app session cookie (cookie prefix rules unchanged). The session
   uses the remember-me lifetime, like the default on `/login`.

## Consequences

- Only package-app visitor sign-in gets the second-device option. A Kody website
  session is never minted by device approval.
- Device-flow phishing is mitigated the same way as 0082: short codes,
  anti-phishing copy, the asking browser's label, and single use.
