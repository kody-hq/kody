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
- Returning social users still land on `/account` (or resume OAuth authorize)

## Device sign-in (`/device`, RFC 8628)

`kody login --device` starts `POST /oauth/device_authorization` and prints a
code. The signed-in person enters or confirms it on `/device`
(`verification_uri_complete` prefills `?user_code=`), sees the consent card with
the anti-phishing line, then picks Approve or Deny.

```bash
curl -s -X POST "$ORIGIN/oauth/device_authorization" \
  -d client_id="$ORIGIN/oauth/cli-client-metadata.json" -d scope='openid profile email'
npm run control-kody -- request GET '/device?user_code=BCDF-GHJK' --contains 'Approve this device?'
```

- Anonymous `/device` shows "Sign in to continue" with `redirectTo` back.
- Unknown or expired codes show the entry form with an error; misses are rate
  limited per person and per IP.
- After Approve, the CLI's next poll gets tokens and mints the device API token
  through `POST /v1/tokens/device` (API host only on previews).
