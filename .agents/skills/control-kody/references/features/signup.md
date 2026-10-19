# Sign up and email verify

## Seed / reach

Prefer local; do not create accounts on shared preview seed.

```bash
npm run control-kody -- request GET /signup --skip-login --contains 'Sign up'
npm run control-kody -- request GET /pending-verification --skip-login
```

## Assert

- `/signup`, `/verify-email`, `/pending-verification`
- Claim / destination flows: `/verify-email-claim-release`,
  `/verify-email-destination`, `/verify-email-change`
- `/unsubscribe/tips`
