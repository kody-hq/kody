# Packages

## Seed / reach

Preview seed has no packages until you create one. Local seed may already have
fixtures after `node tools/seed-test-data.ts --local`.

```bash
npm run control-kody -- login
npm run control-kody -- package-create --origin <preview> --package-name demo-pkg
npm run control-kody -- request GET /@jane --contains 'Repositories'
npm run control-kody -- request GET /account/packages.json --contains 'packages'
```

`package-create` needs the remote `ARTIFACTS` binding — use a PR preview origin,
not `npm run dev`, when proving create/publish. See cloud-agents local
limitations.

## Assert

- Profile / detail: `/@{$username}`, `/@{$username}/$kodyId`,
  `/@{$username}/$kodyId/settings`, `/@{$username}/$kodyId/approve-publish`
- Raw bytes: `/@{$username}/$kodyId/raw/$ref/$`
- Org list: `/@{$orgSlug}/-/repositories` (legacy `/@{$orgSlug}/-/packages`
  301s)
- JSON list: `/account/packages.json`
- Package header: one primary `Open app` (`data-testid="open-package-app"`).
  Approved internet-visible apps href the hosted package-app origin. Private or
  unapproved apps that the viewer may run still use the kody.codes handoff Open
  app href. There is no host-labeled secondary open button
  (`package-app-origin-link` is not in the title action group).
