# Sign up and email verify

## Seed / reach

Prefer local; do not create accounts on shared preview seed.

```bash
npm run control-kody -- request GET /signup --skip-login --contains 'Username'
npm run control-kody -- request GET /signup/choose-username --skip-login
npm run control-kody -- request GET /pending-verification --skip-login
```

## Assert

- `/signup` shows the shared username field (permanence copy, live availability)
- First-time social callback redirects to `/signup/choose-username` with a
  pending cookie and creates no user until username submit
- `/signup`, `/signup/choose-username`, `/verify-email`, `/pending-verification`
- Claim / destination flows: `/verify-email-claim-release`,
  `/verify-email-destination`, `/verify-email-change`
- `/unsubscribe/tips`

## Desktop browser sign-in

- In a shell advertising browser authentication, `/login` and `/signup` offer
  Continue in your browser. Regular browsers keep the existing forms.
- `/desktop/login` validates a loopback callback and S256 challenge, signs in
  through the regular browser flow, then asks the signed-in user to approve.
- `/desktop/session` accepts a one-use code and verifier, rejects replay and
  expiry, and returns an HttpOnly session only to the native main process.
- After local seed login, run
  `npm run test:browser-login --workspace @kodycodes/desktop -- <local-origin>`
  for isolated Electron and browser proof.
