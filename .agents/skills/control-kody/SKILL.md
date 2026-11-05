---
name: control-kody
description: >
  Drive and verify the Kody app with a Feature Map and one CLI. Use when
  changing UI, account routes, preview deploys, or proving a Cloud Agent change
  with a real origin, session, and /health SHA.
---

# control-kody

Do not invent a throwaway curl script, scrape PR comments by hand, or rediscover
account routes from `routeTree.gen.ts`. Use the CLI and the Feature Map.

```bash
npm run control-kody -- --help   # every command, flag, and request/browse/org behavior
npm run control-kody -- doctor
npm run control-kody -- dev
npm run control-kody -- request GET /@user-me/-/waiting --contains 'Waiting'
npm run control-kody -- map waiting
npm run control-kody -- verify waiting   # every request check in that notes file
npm run control-kody -- health --sha <merge-sha> --wait
```

Use `request` for HTML and JSON assertions. Website actions (profile uploads,
organization creation) go through the signed-in browser (`browse`); fixtures go
through `execute` / `search` with `--org`. Prefer MCP/API/`execute` for proof;
use `browse` only when UI is under test. Cursor `computerUse` cannot attach to
the CLI Chromium window: open `/login?redirectTo=<path>` with the public seed
credentials instead.

## Feature Map

[references/features/README.md](./references/features/README.md) is verification
notes (seed, reach, assert). Load **one** feature file for the surface you are
changing. `verify <id>` runs its request lines (GET/HEAD) against `--origin`
(local by default, or a preview). After adding a route file, run
`npm run routes:generate`, then `map --check` (CI runs
`npm run feature-map:check`).

## Seed users

- Local: `jane@example.com` / `ilikecode` (non-admin)
- Preview: `me@kentcdodds.com` / `ilikecode` (non-admin, empty until you create
  data through JSON APIs, or `package-create` for a saved package). Experimenter
  flags stay off unless the PR is labeled `preview-flag:<key>` for a key in
  `tools/preview-seed-flag-allowlist.ts`.
- `/admin` 403 and `/mcp` 401 are expected for those seeds. Admin-gated states
  cannot be preview-tested with the public seed; use the local admin account
  plus Workers or unit tests.
- `packageSave`, publish, and `packageGetGitRemote` / `package-create` work on
  local `npm run dev` with the mock Artifacts API. Use a PR preview when you
  need the real remote Artifacts namespace.

## Proof

CI green is not enough for a user-visible account change. **Local verification
is the default**:

1. `doctor` then `dev` (it prints the migrate and seed commands when needed)
2. `request` as the local seed user **with data for this change**;
   `browse --path <path>` when UI is under test.
3. Use a PR `preview` only when local cannot exercise the change (see
   [Local limitations](../../../docs/contributing/cloud-agents.md#local-limitations)).
4. After merge, `health --origin https://kody.codes --sha <merge> --wait`.

See
[docs/contributing/control-kody.md](../../../docs/contributing/control-kody.md)
and [preview-manual-test](../preview-manual-test/SKILL.md).
