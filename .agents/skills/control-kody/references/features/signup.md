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
