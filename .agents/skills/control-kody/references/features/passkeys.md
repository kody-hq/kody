# Passkeys

## Seed / reach

```bash
npm run control-kody -- login
npm run control-kody -- request GET /account/passkeys --contains 'Passkey'
```

## Assert

- `/account/passkeys` (browser WebAuthn; prefer unit/e2e for register/assert)
