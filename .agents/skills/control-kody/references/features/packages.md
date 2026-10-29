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
  301s). Header `New repository` (`data-testid="repositories-new"`) opens
  `/@{$orgSlug}/-/repositories/new`: owner (personal plus orgs that allow
  `package:create`) and name, created through `repoCreate`; success shows the
  agent start prompt (`data-testid="repository-start-prompt"`), `Copy prompt`,
  and `Open repository`.
- JSON list: `/account/packages.json`
- Package header: one primary `Open app` (`data-testid="open-package-app"`).
  Viewers who may run the app get the handoff Open app href under
  packages/`…`/`open` (self-describing; not a Start route); that handoff prefers
  a verified app custom hostname over `{username}.kody.run/{name}`. Public
  readers of an internet-visible app get that same hosted URL directly (custom
  hostname when verified, else the kody.run subdomain). There is no host-labeled
  secondary open button (`package-app-origin-link` is not in the title action
  group).

## Skills viewer

- Reach `/@{$orgSlug}/-/skills` from the Skills sidebar item.
- Publish two local fixture packages with `skills/<name>/SKILL.md` and at least
  one supporting Markdown and source file. Use `control-kody execute` against
  the local mock Artifacts origin to create the fixtures.
- Check All skills, By package, name/description/package search, and no matches.
- Open instructions, raw Markdown, and supporting files inside the viewer.
- Back to skills preserves the search and grouping; direct skill/file URLs load
  the same selection. Repeat at a narrow viewport.
- Verify with the MCP skills flag off. A caller without package read access must
  not see the skill or read its files through a direct selection URL.

## Skill history

- Open a skill, then **History**. Choose a published version and supporting
  file.
- Turn on **Show changes** and compare two versions. Added and removed lines and
  files must be distinguishable without relying on color alone.
- A reader can compare history but cannot restore. With package write access,
  **Restore this version**, then **Restore and publish**, creates a new checked
  revision of only that skill directory. Verify binary assets, deleted later
  files, and unchanged neighboring skills. Publish locks still need approval.
- Publish another change after opening history. A stale restore must fail.
  Refresh after restoring to verify the revision persisted.
