# Password reset

Forgot-password and signed-in password change.

## How to get there

Signed-out: `/reset-password`. Signed-in: account settings password form.

## Drive it

Do not POST a new password that matches the shared seed (`ilikecode`) — that
does not prove the change. Prefer GET the form. If you must mutate, use a
distinct temporary password and restore `ilikecode` afterward.

```bash
node tools/control-kody.ts request GET /account
node tools/control-kody.ts request GET /reset-password --skip-login
```

GET the page after a change; do not stop at "try this URL."

## Transport

Password reset, confirmation, and signed-in password changes use native Start
server functions through their browser forms.
