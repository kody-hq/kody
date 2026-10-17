# Sign in

Email + password (and social providers when configured).

## How to get there

Open `/login`. Button label is **Sign in**.

## Drive it

```bash
node tools/control-kody.ts login --origin http://localhost:3742
node tools/control-kody.ts request GET /session --origin http://localhost:3742
```

Local default: `jane@example.com` / `ilikecode`. Preview default:
`me@kentcdodds.com` / `ilikecode`.

## APIs

- `POST /auth` `{ email, password, mode: "login" }`
- `GET /session` Provider reads and logout use native Start server functions
  through the UI.

## Gotchas

- `/mcp` is 401 without OAuth. Not a regression.
- Social-login e2e is a known wrangler-sensitive path; prefer the email lane for
  agent verification.
