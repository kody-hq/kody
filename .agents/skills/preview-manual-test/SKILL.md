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

Read
[`docs/contributing/preview-manual-testing.md`](../../../docs/contributing/preview-manual-testing.md).
Do not improvise `gh` comment scraping, local E2E against the preview URL, or
raw D1 seeding of preview resources.

Prefer [`control-kody`](../control-kody/SKILL.md) when you also need `doctor`,
local login, Feature Map lookup, or a `/health` SHA check:

```bash
npm run control-kody -- preview --pr 42 --request 'GET /session' --check /onboarding/step-2
```

## Command

```bash
npm run preview:manual-test
```

On **medium or high risk**, do not stop at the default health/login smoke. The
seed user (`me@kentcdodds.com` / `ilikecode`, username `user-me`) has **no**
secrets, packages, or jobs until you create them. Script that data and the
assertions as the same logged-in user:

```bash
npm run preview:manual-test -- \
  --request 'GET /session' \
  --check /onboarding/step-2
```

`--request` spec:
`METHOD /path [status] [json-body] [--dump] [--contains <text>]` (default
success: 2xx). `--dump` / `--contains` match `control-kody request`, e.g.
`--request 'GET /pricing --dump --contains Worker compute'`. Create fixtures
through supported MCP capabilities with `control-kody execute` or the browser
UI. Website-only reads and mutations use Start server functions; exercise those
through the browser, not retired JSON action URLs. `/session`, `/auth`, and
`/account/export.json` remain HTTP protocols. `GET /account/export.json` is a
metadata manifest only — do not `--contains` user data there; verify rows with
MCP `accountExportSection` via `control-kody execute` (see the contributing
doc). For more authenticated HTTP after login, use `control-kody request`
(`--dump` / `--contains` for HTML). Do not cat the session cookie into `curl` or
Python.

`--pr`, `--url`, `--no-wait`, `--skip-login`, `--help` as documented.

The briefing's `API:` line is the preview's Open API host,
`https://kody-pr-<n>-api.kody-a99.workers.dev`, and the next line prints
`export KODY_API_URL=…` for it. `@kodycodes/cli` (`auth bootstrap`,
`execute --local`) needs that host; the app origin 404s `/v1/*` with HTML. See
[CLI against a PR preview](../../../docs/contributing/cloud-agents.md#cli-against-a-pr-preview).

Flag-gated preview checks need a `preview-flag:<key>` label for a key in
`tools/preview-seed-flag-allowlist.ts` before 🔎 Preview seeds. Example for
connection profiles:

```bash
# PR label: preview-flag:connection-profiles
# .github/workflows/preview.yml then seeds with:
# node tools/seed-test-data.ts --remote --config "$WRANGLER_CONFIG" \
#   --email me@kentcdodds.com --password ilikecode \
#   --enable-flag connection-profiles
npm run control-kody -- preview --pr 42 --check /account/connected-agents
```

Open `/account/connected-agents` in the signed-in browser and verify the
connection profile controls. A successful HTML check alone does not prove the
flag-gated interaction works.

`--enable-flag` with `--remote` fails unless the wrangler env is `preview`.

## When

Prefer local [control-kody](../control-kody/SKILL.md) verification
(`dev`/`login`/`request`/`browse`/`execute`) for UI and API changes. Use a PR
preview when local cannot exercise the change: Workers / service bindings,
Durable Objects, real OAuth or inbound third-party webhooks, deploy / wrangler /
config, the real remote Artifacts namespace, or when the user asks to try the
preview URL. Local `packageSave` / publish use the mock Artifacts API. After the
PR is **ready for review** (drafts and forks have no preview) and you have
pushed the commits you want to exercise.

This does not replace `npm run validate` or local control-kody proof.

## After the scripted session

Default: prove behavior via MCP/API/`control-kody` `request` / `execute`. Open a
browser only when UI is under test.

When UI is under test:

1. Prefer `npm run control-kody -- browse --origin <preview> --path <path>` so
   Chromium opens already signed in (reuses `.tmp/control-kody-cookie`).
   Optional `--record` writes video under `.tmp/control-kody-browse`.
2. Cursor `computerUse` cannot drive that Playwright window. For computerUse,
   open `/login?redirectTo=<path>` (seed email `me@kentcdodds.com` / password
   `ilikecode`, button **Sign in**) and stay on the preview origin.
3. Confirm the data you created and exercise the UI this PR changes.
4. Record what you saw on the PR.

`GET /mcp` is 401 without OAuth; `/admin` is 403 (seed account is not admin).
Neither is a regression. Admin-gated states (suspension, outbound-email pause,
account deletion) cannot be set on preview; use the local admin seed plus
Workers or unit tests. For MCP `execute` / `search` fixtures, use
`control-kody execute` / `search` — do not hand-roll OAuth. Two `packageSave`
packages on the seed account share implicit user-secret read; locked-secret
denial needs an unadopted community fork. See
[preview-manual-testing.md](../../../docs/contributing/preview-manual-testing.md).
