# Password reset

## Seed / reach

```bash
npm run control-kody -- request GET /reset-password --skip-login --contains 'Reset'
```

## Assert

- Public form at `/reset-password` (Start server function; no separate JSON API)
