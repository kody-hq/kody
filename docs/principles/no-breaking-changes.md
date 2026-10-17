# No breaking changes

We do not break people and their packages. If we ever need to make a breaking
change, we do it through a phased migration with a codemod, so users don't even
need to know what's going on. If a codemod isn't possible, we run a phased
migration and send a manual email explaining the change, including prompts users
can hand their agents to do the migration (or manual instructions if needed).
Then we give them time to migrate, proportional to how long, how complicated,
and how impactful the migration is.

## Example

Credential stamps (#3836) are a one-way door for new credential use: the publish
gate requires fixed `kody.credentials` slots and still rejects
`packageSecrets.get`. A package may keep `kody.secretMounts` so a stale static
dependent that bundled `packageSecrets.get` keeps resolving that alias against
the current published manifest. The kept mount grants nothing new: resolution
still checks the declared credential slot, actor Use, package approval, and a
fresh secret lookup. Removing a mount, or deleting the secret it names, cuts
those dependents off on their next call, and publish warnings name them.
Existing packages that still use runtime-chosen names or `|scope=` stay
runnable; a platform codemod (`0015-convert-credential-stamps`) rewrites drifted
published trees, and the stamp gate only hard-fails new publishes that are not
conversion-ready. Owners see guidance in the gate message rather than a sudden
runtime break.

## Related

- [Two-way and one-way doors](./two-way-doors.md): when a public contract is a
  one-way door
- [Cleanup](./cleanup.md): finish the migration by deleting the old lane
- [Cleanup after migrations](../contributing/cleanup-after-migrations.md)
