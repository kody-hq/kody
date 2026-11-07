---
name: preview-manual-test
description: >
  Discover, wait for, sign in, create specific user data, and assert a PR
  preview deploy. Prefer local control-kody verification first. Use a preview
  when local cannot exercise the change (Workers bindings, Durable Objects, real
  OAuth/webhooks, deploy/wrangler/config, Artifacts), after pushing a
  ready-for-review PR, or when the user asks to test the preview URL.
---

# Manual preview testing

```bash
npm run preview:manual-test -- --help   # flags, --request spec, export.json caveat
npm run control-kody -- preview --pr 42 --request 'GET /session' --check /onboarding/step-2
```

Do not improvise `gh` comment scraping, local E2E against the preview URL, or
raw D1 seeding of preview resources. Details:
[`docs/contributing/preview-manual-testing.md`](../../../docs/contributing/preview-manual-testing.md).

## When

Prefer local [control-kody](../control-kody/SKILL.md) verification. Use a PR
preview only when local cannot exercise the change (Workers / service bindings,
Durable Objects, real OAuth or inbound webhooks, deploy / wrangler / config, the
real remote Artifacts namespace) or when the user asks. The PR must be **ready
for review** (drafts and forks have no preview). This does not replace
`npm run validate`.

## Data and accounts

On **medium or high risk**, do not stop at the default health/login smoke. The
seed user (`me@kentcdodds.com` / `ilikecode`, username `user-me`) has **no**
secrets, packages, or jobs until you create them through `control-kody execute`
or the browser UI. A second non-admin account (`preview-member@example.com` /
`ilikecode`) is always seeded; the `preview-seed:team-org` label adds the team
org `preview-team` (seed user Owner, member account Member). Owner and member
permission fixes are verified on the preview; see
[Authorization checks](../../../docs/contributing/preview-manual-testing.md#authorization-checks).

- CLI (`auth bootstrap`, `execute --local`) needs the `export KODY_API_URL=…`
  host the briefing prints, not the app origin.
- Flag-gated pages need a `preview-flag:<key>` label (keys in
  `tools/preview-seed-flag-allowlist.ts`) before 🔎 Preview seeds; then open the
  page in the signed-in browser. An HTML check alone does not prove the flagged
  interaction.
- `/mcp` 401 and `/admin` 403 are expected. Admin-gated states (suspension,
  outbound-email pause, account deletion) need the local admin seed plus Workers
  or unit tests.
- Two `packageSave` packages on the seed account share implicit user-secret
  read; locked-secret denial needs an unadopted community fork.

## UI under test

Prove behavior via MCP/API/`control-kody` first. For UI, use
`control-kody browse --origin <preview> --path <path>` (signed in;
`--screenshot`, `--record`). Cursor `computerUse` instead opens
`/login?redirectTo=<path>` on the preview origin with the seed credentials.
Confirm the data you created, exercise the changed UI, and record what you saw
on the PR.
