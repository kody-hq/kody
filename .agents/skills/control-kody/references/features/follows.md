# Follows

## Seed / reach

```bash
npm run control-kody -- login
npm run control-kody -- request GET /@jane/-/follows --contains 'Follow'
```

Follow controls on a package page are under packages notes
(`/@{$username}/$kodyId`).

## Assert

- `/@{$orgSlug}/-/follows`
