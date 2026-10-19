# Sign in

## Seed / reach

Local: `jane@example.com` / `ilikecode`. Preview: `me@kentcdodds.com` /
`ilikecode`.

```bash
npm run control-kody -- login
npm run control-kody -- request GET /session --contains '"email"'
npm run control-kody -- request GET /login --skip-login --contains 'Sign in'
```

## Assert

- `POST /auth` `{ email, password, mode: "login" }` sets the session cookie
- `GET /session` returns the signed-in user JSON
- MCP endpoint without OAuth returns 401 (expected for seed users)
