# Sign up and email verify

Create an account, then confirm email.

## How to get there

`/signup` → verification email → `/verify-email` or `/pending-verification`.
Email-change confirm is `/verify-email-change` (token from the change email).
Former-address release confirm is `/verify-email-claim-release`. Extra
email-destination confirm is `/verify-email-destination`. Kody tips opt-out is
`/unsubscribe/tips` (signed token from campaign mail).

## Drive it

Prefer the seeded login. Creating accounts in preview is rarely needed.

```bash
node tools/control-kody.ts request GET /signup --origin http://localhost:3742 --skip-login
```

## APIs

- `POST /auth` `{ mode: "signup", ... }` Resend verification through the browser
  control, which uses a native server function.

## Gotchas

- Preview seed is already verified. Do not invent a second user unless the
  change is the signup path itself.
- Signup copy: "By creating an account you agree to the Terms of Service and
  acknowledge the Privacy Policy" (`/terms`, `/privacy`).
- Signup is open. New accounts start on the free plan.
- Person accounts that stay unverified for seven days are deleted.
