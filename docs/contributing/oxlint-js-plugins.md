# Oxlint JS plugin pattern

Add a custom rule for a local, syntactic constraint. If the check would need
control-flow or interprocedural guessing, document the failure mode instead. See
[documentation principles](./documentation.md) and
[harness engineering](./harness-engineering.md).

## Add or change a rule

1. Use the default-exported [local plugin](../../tools/oxlint/local-plugin.js)
   as the baseline. Write Oxlint-only rules with `createOnce` (no ESLint
   adapter). The plugin's `meta.name` provides the namespace; its `rules` object
   maps rule names to implementations.
2. Enable `kody-custom/<rule-name>` in the
   [local rule config](../../tools/oxlint/oxlint-rules.json). Use its overrides
   to scope rules and leave the [root config](../../.oxlintrc.json) unchanged.
3. Test matching and non-matching cases. Use the
   [non-retryable error lint test](../../tools/oxlint/no-nonretryable-error-name.node.test.ts)
   for a linter fixture or the
   [import boundary test](../../tools/oxlint/import-boundaries.node.test.ts) for
   a data-driven rule.

See the plugin's `rules` object for the full inventory and
[Oxlint's JS plugin docs](https://oxc.rs/docs/guide/usage/linter/js-plugins.html)
for the API.

## Request-path rules

[Request handlers](./request-handlers.md) explains how to give outbound calls
deadlines, handle promises and typed failures, and settle queue messages. The
[local rule config](../../tools/oxlint/oxlint-rules.json) lists which paths
enforce those rules, including selected queue and watchdog entry points.

For details such as which queue producer calls need a deadline or which
error-handling patterns lint accepts, see the
[rule implementation](../../tools/oxlint/request-path-safety.js) and
[fixture tests](../../tools/oxlint/request-path-safety.node.test.ts). For a
deliberate exception, use `oxlint-disable-next-line` with the reason after `--`.

## Built-in rules and separate checks

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
