# Writing tests

Open this when a change might need a test. Flavors and commands live in
[testing principles](./testing-principles.md).

## Decide whether the change needs a test

"No new tests needed" is the normal answer when existing tests already run the
changed path, when the change is copy, layout, docs, config, or a refactor that
keeps behavior, or when a break would show up right away (CI scripts that CI
runs, UI that [ui:verify](./ui-verify.md) renders).

Add a test when it protects behavior that could break silently:

- A denial or invariant in a critical area: auth, permissions, billing and
  credits, secrets and credentials, data integrity (soft delete, restore,
  migrations), DR and backups, the publish pipeline, and sandbox or egress
  security.
- A bug fix: one regression test that fails when the fix is reverted.
- New logic whose outcome no other test observes.

## Put it where the capability is already tested

1. Add a case to the existing test for that capability. Search by handler, MCP
   tool, route, or service name.
2. Otherwise write one workflow test at the highest offline layer that reaches
   the behavior: the real handler with real authorization and the D1 facade, or
   real bindings in a `*.workers.test.ts`.
3. Mock what cannot run offline: the network, third parties, and platform
   services.

## Assert what a user or caller would notice

- Status, error code, returned data, stored rows, audit events, and charged
  credits.
- Expected values the test works out itself, so a wrong production constant or
  helper still fails it.
- One case for each input that behaves differently.

See [Test the workflow](../principles/test-the-workflow.md) for test shape.

## In the PR

Fill in **New tests** in the PR template: "No new tests needed", or for each new
long-lived test, the behavior it protects and why existing tests do not cover
it.
