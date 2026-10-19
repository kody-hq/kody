# Two-factor auth

## Seed / reach

Signed-in local user:

```bash
npm run control-kody -- login
npm run control-kody -- request GET /account/two-factor --contains 'Two-factor'
```

## Assert

- Settings: `/account/two-factor`
- Challenge: `/verify` (when 2FA is enabled on the account)
