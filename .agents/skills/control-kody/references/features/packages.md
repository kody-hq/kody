# Packages

## Seed / reach

Preview seed has no packages until you create one. Local seed may already have
fixtures after `node tools/seed-test-data.ts --local`.

```bash
npm run control-kody -- login
npm run control-kody -- package-create --origin <preview> --package-name demo-pkg
npm run control-kody -- request GET /@jane --contains 'Repositories'
npm run control-kody -- request GET /@jane/-/repositories --contains 'Packages live here too'
npm run control-kody -- request GET /account/packages.json --contains 'packages'
```

`package-create` needs the remote `ARTIFACTS` binding — use a PR preview origin,
not `npm run dev`, when proving create/publish. See cloud-agents local
limitations.

## Assert

- Profile / detail: `/@{$username}`, `/@{$username}/$kodyId`,
  `/@{$username}/$kodyId/settings`, `/@{$username}/$kodyId/approve-publish`
- Forks: `/@{$username}/$kodyId/forks` (public forks plus private ones the
  viewer can read; the detail Forks count links here and uses the same rule)
- Raw bytes: `/@{$username}/$kodyId/raw/$ref/$`
- Org list: `/@{$orgSlug}/-/repositories` (legacy `/@{$orgSlug}/-/packages`
  301s)
- JSON list: `/account/packages.json`
- Package header: one primary `Open app` (`data-testid="open-package-app"`).
  Viewers who may run the app get the handoff Open app href under
  packages/`…`/`open` (self-describing; not a Start route); that handoff prefers
  a verified app custom hostname over `{username}.kody.run/{name}`. Public
  readers of an internet-visible app get that same hosted URL directly (custom
  hostname when verified, else the kody.run subdomain). There is no host-labeled
  secondary open button (`package-app-origin-link` is not in the title action
  group).
