# End-to-end testing principles

These notes summarize how we approach Playwright tests in this codebase, based
on the Epic Web E2E workshop and our existing setup.

## Goals

- Validate user-visible journeys end-to-end through the worker and client.
- Prefer a few high-signal tests over many brittle ones.
- Keep tests readable and close to how a user describes behavior.
- Keep the bar for adding an E2E test very high.

## What to test

- Only the most important happy-path user flows.
- Primary routes and flows that would make the product feel broken if they
  stopped working.
- Integration across the worker, client router, and API endpoints when that
  journey is central to the product.

Avoid testing implementation details, styling, or pure utility functions. Avoid
adding E2E coverage for edge cases, low-probability regressions, or bug fixes
that are unlikely to recur.

## Bar for adding a test

- Default to not adding a new E2E test.
- Add one only when the flow is both user-critical and hard to cover with faster
  tests.
- Prefer a single broad happy-path journey over multiple narrow regression
  cases.
- If a bug is unlikely to show up again, do not add an E2E test just to lock in
  the fix.
- For MCP specifically, treat `*.mcp-e2e.test.ts` as a tiny transport smoke
  suite. Do not add capability-by-capability coverage there unless the failure
  mode depends on the real MCP HTTP transport, OAuth flow, or package-app
  session wiring.

## Structure and style

- Keep tests flat: top-level `test(...)` with no `describe` nesting.
- Inline setup per test; avoid shared `beforeEach` unless required.
- Prefer fewer, longer tests when one user journey covers the behavior.
- Treat each E2E test like a manual tester's script: one setup, then the actions
  and assertions needed to validate the whole flow.
- Do not split a single journey into multiple tiny tests just to isolate each
  assertion.
- Use Playwright’s `expect` and locator APIs (role/label/placeholder).

## Locators

Prefer stable, user-facing selectors:

- `getByRole` for buttons, links, headings, and inputs.
- `getByLabel` for form fields.
- `getByText` only for brief, stable copy.

Avoid `page.locator('css')` unless no accessible alternative exists.

## Server and routing

- The test server is started via Playwright `webServer` using Vite.
- `playwright.config.ts` starts the E2E server with
  `npm run e2e:web-server -- --port 3847` (D1 migrations + the local Cloudflare
  API mock + Vite with `CLOUDFLARE_ENV=test`) and waits on `/health`. The test
  env keeps jobs and highlight as Vite auxiliary workers; platform/runtime
  auxiliary workers are skipped.
- `tools/e2e-web-server.ts` starts `packages/mock-servers/cloudflare` and points
  the origin worker's `CLOUDFLARE_API_BASE_URL` / `CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID` at it so signup and other transactional mail go
  through the same Email Sending mock `npm run dev` uses. The mock Durable
  Object retains outbound messages. Specs read them from authenticated
  `GET /__mocks/messages` (Bearer token or `?token=`) using the origin and token
  written to `.wrangler/state/e2e/cloudflare-mock.json`. Do not pull
  verification tokens out of D1 as the primary path; that skips the email leg.
- `preview:e2e` is the manual path: it prepares `packages/worker/.env`, applies
  local D1 migrations, and starts Vite against `.wrangler/state/e2e`.
- `npm run test:e2e:run` ensures Playwright Chromium is installed before the
  suite starts (`tools/ensure-playwright-browser.ts`). On Cloud Agent Linux that
  uses native `unzip` for the `browsers.json` revision; elsewhere it uses
  `playwright install`. The Validate E2E job restores `~/.cache/ms-playwright`
  from Actions cache and calls the same ensure script, so a matching Playwright
  revision does not download or run `apt-get`.
- `npm run test:e2e:ui` and plain `npx playwright test` assume Playwright
  browsers are already installed.
- Playwright sets `CLOUDFLARE_ENV=test`; Wrangler loads `packages/worker/.env`
  values for local secrets. That test env is a **single script**: Durable Object
  classes run on `kody-test` with no `script_name`. Production and `npm run dev`
  attach origin, platform, runtime, jobs, and highlight as siblings. The test
  env still starts jobs and highlight as auxiliary workers.
- Specs import `test` from `e2e/playwright-utils.ts`, which probes `/health`
  before each test and fails fast with `E2eWebServerDeadError` if Wrangler has
  exited mid-suite (avoids burning retries on `ECONNREFUSED`). That error names
  the unread `request.clone()` tee fix (`discardUnreadRequestBody` in
  `#worker/request-body.ts`) when logs show `Network connection lost` /
  `Error inside ProxyWorker`. Wrangler 4.131+ logs that ProxyWorker failure
  without exiting `wrangler dev` (workers-sdk#15252). Playwright also keeps
  wrangler's default incoming-body drain enabled so unused proxy tees do not
  kill the isolate. `wrangler-env.ts` and the Playwright webServer set
  `X_LOCAL_EXPLORER=false` because wrangler 4.127+ starts Miniflare's local
  explorer by default; on Cloud Agent / CI hosts, explorer writes under
  `.wrangler/tmp` retrigger esbuild and leave ProxyWorker in a pause/reload loop
  after Ready. Opt in with `X_LOCAL_EXPLORER=true`. `wrangler-env.ts` also sets
  `WRANGLER_DISABLE_BUNDLE_WATCH=true` in the test env so esbuild's source-graph
  watcher does not rebuild after the first compile on Cloud Agent overlay FS
  (Friction #1789). `tools/e2e-web-server.ts` refuses to start when a leftover
  `dev:ensure` origin on 3742–3751 is listening but `/health` fails (a
  crash-looping Vite after `npm ci` collides on the inspector port and fails
  `fetchWorkerExportTypes`). A **healthy** origin can stay up: e2e uses port
  3847, `.wrangler/state/e2e`, and `KODY_E2E_WEB_SERVER=1` (disables the Vite
  Cloudflare inspector) so validate does not require killing `dev:ensure`
  (#3731). Set `PLAYWRIGHT_BASE_URL` to reuse an existing server instead. It
  also restarts Vite once if the first process exits before Playwright reaches
  `/health`. On CI, Validate runs Playwright as four `--shard=i/4` matrix jobs
  (each on its own runner / D1 file; `workers: 1` stays). Each shard retries
  once when `tools/ci/retry-classifiers.ts e2e` matches a webServer start crash
  (`Process from config.webServer was not able to start`, including Vite
  `__LOAD__ is not defined` during Cloudflare export-type inspection), a
  mid-suite death on port 3847, or a recovered workerd crash
  (`The Workers runtime crashed unexpectedly and is being restarted`). Genuine
  assertion failures do not retry. Shards upload Playwright `blob` reports; the
  `🎭 E2E Report` job merges them with `playwright merge-reports` into one HTML
  artifact. Failed shards also upload `logs.local/` as
  `e2e-wrangler-logs-<shard>`.
- Ensure the `env.test` section in `packages/worker/wrangler.jsonc` includes
  assets, KV, and durable objects since these are not inherited from top-level
  Wrangler config.
- Ensure `packages/worker/.env` includes a `COOKIE_SECRET` var for local
  sessions.
- Client routes live in `packages/worker/start/routes/` and use
  `packages/worker/start/router.tsx`.
- Native protocol routes live alongside page routes. Their shared handlers are
  in `packages/worker/start/server/protocol-handlers.ts`. Website reads and
  writes use Start server functions.

When adding endpoints that accept bodies, ensure POST/PUT requests are not
handled by the static asset fetcher in `packages/worker/src/index.ts`.

## Test data

- Use real input values and a happy-path payload.
- Keep credentials and emails obviously fake and local-only.
- Avoid hidden fixtures or global state in the Playwright tests.

## Assertions

- Assert user-facing results (success message, redirect, visible element).
- For async actions, wait on the UI result, not arbitrary timeouts.
- Assert important intermediate states as part of the same journey that causes
  them instead of creating isolated loading-state or transition-state tests.
- After `page.goto`, wait for client hydration before clicking JS-only controls
  (`waitForClientHydration` in `e2e/playwright-utils.ts`). Start sets
  `html[data-hydrated=true]` after the client hydrates, so SSR headings are
  visible while click handlers are still unbound.
- For client-router regressions, you may set a `window` marker before clicking a
  link and assert it survives navigation to prove there was no full document
  reload.
- Use the same marker pattern for form submissions (for example logout) when
  verifying router-handled form navigation.

## Running tests

Common commands:

- `npm run test:e2e:run`
- `npm run test:e2e:install`
- `npm run test:e2e:run -- --grep "smoke test"`
- `npx playwright test`
- `npx playwright test e2e/login.spec.ts`

For MCP capability work, prefer `*.node.test.ts` or `*.workers.test.ts` beside
the implementation (see the
[test flavor decision matrix](./testing-principles.md#test-flavor-decision-matrix))
and keep `npm run test:mcp` limited to a couple of high-signal smoke journeys.

If `packages/worker/.env` is missing, the E2E server startup path copies
`packages/worker/.env.example` to `packages/worker/.env` before Wrangler starts.

These tests are executed by the `validate` gate, alongside `format:check`,
`lint`, `typecheck`, unit tests, and the MCP E2E suite. `validate` is read-only;
use `npm run validate:fix` for `lint:fix` then `format`.
