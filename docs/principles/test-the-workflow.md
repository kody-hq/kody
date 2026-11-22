# Test the workflow

One test is one workflow: the setup, the actions, and the assertions that prove
it. An assertion needs an oracle the production code does not share.

## Example

```ts
expect(isResetMessage(resetMessageConstant.replace(/\.$/, ''))).toBe(true)
```

That fails when normalization changes.
`expect(isResetMessage(resetMessageConstant)).toBe(true)` does not: the matcher
is the constant.

## Rules

- Flat `test(...)`. Inline the setup. Skip `describe`, `beforeEach`, and shared
  mutable state.
- Skip pins of exported constants, copies of the production helper, and checks
  the type system already makes.
- An absence assertion belongs on a live path that can still show the thing
  (admin vs user, empty vs populated). `kody-custom/no-tautological-absence`
  (`npm run lint`) rejects vanished instructional copy.
- Keep the bar high. Unit tests for logic. A few Playwright journeys for
  user-critical paths. Tests run offline.

Flavor choice, console spies, workers pool, and `using`:
[Test runners](../contributing/test-runners.md). Production seams:
[No invasive test-only code](./no-invasive-test-only-code.md).
