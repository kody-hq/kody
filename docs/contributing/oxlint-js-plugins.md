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

`kody-custom/no-tautological-absence` is the haystack pattern: helpers in
`tautological-absence.js` walk the repo once per lint process, then the visitor
reports on the current test file.
`tools/oxlint/tautological-absence.node.test.ts` asserts the heuristic without
spawning the linter for every case.

`kody-custom/no-oversized-guide-section` walks official guides under
`docs/guides/` (not `README.md`) and reports on
`packages/worker/src/guides/catalog.ts` when a requestable heading (`##` or
deeper) exceeds the search body budget: `maxChars` minus the `guide:{id}` entity
header and mode line. Helpers live in `guide-section-budget.js` so
`tools/oxlint/guide-section-budget.node.test.ts` can assert the parser and
budget against the runtime heading and header code without spawning oxlint for
every case.

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
