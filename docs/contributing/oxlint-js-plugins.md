# Oxlint JS plugin pattern

Use this repo's local plugin as the baseline pattern for custom oxlint rules.

When a contributing constraint is local and syntactic, add a rule here instead
of a should-list in docs. Docs still describe how the system works and can point
at the rule; they do not replace it. Skip a rule that would need control-flow or
interprocedural guessing — that stays a short failure-mode note, not a noisy
half-check. See [documentation principles](./documentation.md) and
[harness engineering](./harness-engineering.md).

## Files

- Plugin: `tools/oxlint/local-plugin.js`
- Plugin config: `tools/oxlint/oxlint-rules.json`
- Root config: `.oxlintrc.json`

## Pattern

1. Create a JS module that default-exports a plugin object.
2. Write rules with `createOnce` (alternative API) instead of `create`.
3. Keep rule metadata/rule names the same:
   - `meta.name` defines the rule namespace.
   - `rules` maps rule names to rule objects.
4. Add plugin paths and rule toggles in `tools/oxlint/oxlint-rules.json`.
5. Keep `.oxlintrc.json` stable by extending that file.
6. Enable rules using `<plugin-name>/<rule-name>`.

## Why this API here

This repo standardizes on Oxlint's alternative API (`createOnce`) for custom
rules. We are not targeting ESLint usage for these local plugins, so we keep
plugins Oxlint-only and do not include ESLint-compat helpers.

## Config layout

`.oxlintrc.json` should only contain shared/base extends plus a single extend to
`tools/oxlint/oxlint-rules.json`. Add or change custom JS plugins and local rule
settings in `tools/oxlint/oxlint-rules.json` so new rules do not require
touching root config.

## Example in this repo

- Plugin name: `kody-custom`
- Rule id: `no-example-identifier`
- Config key: `kody-custom/no-example-identifier`

The example rule reports when it finds the identifier
`__oxlint_plugin_example__`. This keeps the demo deterministic and avoids
accidentally linting normal production code.

Another live example is `kody-custom/prefer-loader-data-types`, which scopes
itself to `packages/worker/client/routes/**` and reports route-local TypeScript
payload declarations that should instead be imported from
`#universal/loader-data.ts`.

`kody-custom/enforce-import-boundaries` shows the pattern for a data-driven
rule: the boundaries and their allowlists are plain objects at the top of the
plugin, and the matching helpers are exported so
`tools/oxlint/import-boundaries.node.test.ts` can assert the configuration
without spawning the linter. See [import boundaries](./import-boundaries.md) for
the layering it enforces.

`kody-custom/no-nonretryable-error-name` rejects
`new NonRetryableError(message, name)`. The Workflows engine skips retries only
when the error name is `NonRetryableError`, so a custom name quietly makes a
terminal step failure retry. Keep error codes in the message.
`tools/oxlint/no-nonretryable-error-name.node.test.ts` runs the linter on a
fixture.

`kody-custom/no-tautological-absence` is the haystack pattern: helpers in
`tautological-absence.js` walk the repo once per lint process, then the visitor
reports on the current test file.

`kody-custom/no-oversized-guide-section` walks official guides under
`docs/guides/` (not `README.md`) and reports on
`packages/worker/src/guides/catalog.ts` when a requestable heading (`##` or
deeper) exceeds the search body budget: `maxChars` minus the `guide:{id}` entity
header and mode line. Helpers live in `guide-section-budget.js`.

`kody-custom/no-test-hooks-in-production` keeps production files identical under
tests: no `*ForTests` / `*ForTesting` declarations and no test-runner checks
(`process.env.VITEST`, `NODE_ENV === 'test'`). Test files, test-support modules,
fixtures, and `e2e/` are exempt. Per-isolate caches use `isolateState` /
`isolateCollection` from `@kody-internal/shared/isolate-state.ts`, and tests
reset them with `resetIsolateState()` from `isolate-state-test-support.ts`.
`tools/oxlint/no-test-hooks-in-production.node.test.ts` runs the linter on a
fixture.

`kody-custom/require-exit-condition-comment` makes a production comment about a
legacy, compatibility, temporary, or "for now" path say how it ends: a
`Remove when: <issue or metric>` line, or `Permanent: <why>` when the behavior
stays. Inline code spans are ignored, so naming an identifier such as `legacy`
does not trip it. When the condition already holds, delete the path.
`tools/oxlint/require-exit-condition-comment.node.test.ts` runs the linter on a
fixture.

Request handlers have three rules in `request-path-safety.js`, turned on as
errors for `packages/worker/src/open-api/`,
`packages/worker/src/publish-offload/`, and the publish build entry points in
the request-path override in `tools/oxlint/oxlint-rules.json`. Widen them by
adding a directory to that `files` list.
[Request handlers](./request-handlers.md) says how to write code that passes
them.

- `kody-custom/require-outbound-deadline`: D1, KV, R2, `fetch`, `*Rpc`
  factories, Durable Object stub calls, Artifacts repo handles, and the boundary
  helpers listed in `OUTBOUND_IMPORTS` (for example `routeExecute`) must sit
  inside `withDeadline({ label, timeoutMs }, (signal) => ...)` from
  `#worker/outbound/with-deadline.ts`. Pick `timeoutMs` explicitly; there is no
  default.
- `kody-custom/no-floating-promise`: a promise is awaited, returned, or handed
  to `waitUntil`. `void promise` is reported, and so are calls to async
  functions imported from relative or `#worker/` modules.
- `kody-custom/no-swallowed-error`: a `catch` or `.catch` handler rethrows,
  returns a `{ kind }` failure, calls a `...Failure` builder or mapper or an
  `...ErrorResponse` edge mapper, records into `warnings` / `failures` /
  `record...Error`, or calls `reportHandledError` from
  `#worker/outbound/typed-failure.ts`.

The rules are syntactic: a deliberate exception takes an
`oxlint-disable-next-line` with the reason after `--`.
`tools/oxlint/request-path-safety.node.test.ts` runs the linter on fixtures.

`react/exhaustive-deps` runs at error. Read values an effect should not react to
through `useEffectEvent`. Unused disable directives are errors
(`reportUnusedDisableDirectives` in `.oxlintrc.json`), so a directive goes away
with the problem it silenced.

Repo-wide syntactic bans that do not need a custom visitor live in the same
config as built-in rules: `typescript/no-explicit-any` and
`eslint/no-warning-comments` for `TODO` / `FIXME` / `HACK`. File-size allowlists
and decorative comment banners stay a separate `validate` script
(`npm run slop-ratchet:check`) because they are allowlist / inventory checks,
not per-file lint rules.

## Verify manually

Create a temporary file containing the sentinel identifier and run:

```sh
npm run lint -- ./tmp-oxlint-plugin-rule-test.js
```

You should see a lint error from `kody-custom/no-example-identifier`. Delete the
temporary file after verification.

## References

- https://oxc.rs/docs/guide/usage/linter/js-plugins.html
