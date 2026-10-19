# Waiting inbox

## Seed / reach

```bash
npm run control-kody -- login
npm run control-kody -- request GET /@jane/-/waiting --dump --contains 'Waiting'
npm run control-kody -- request GET /account/waiting 302 --contains /@jane/-/waiting
npm run control-kody -- browse --path /@jane/-/waiting
```

Seed accounts usually still show first-use setup cards until gates clear. Create
pending grants or locked packages via `execute` / UI before asserting empty.

## Assert

- `/@{$orgSlug}/-/waiting` (HTML); `/account/waiting` redirects there
- Error-rate card counts **open** Activity errors in the last 7 days only
