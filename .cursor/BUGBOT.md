# Review guidance

Hold changes to [code style](../docs/contributing/code-style.md). Flag:

- A `catch` that continues ("best effort", "non-blocking") without logging the
  failure and stating what the user loses.
- Comments that narrate history ("no longer", "used to", "previously") or repeat
  the code. Ask for a why, or delete the comment.
- A legacy, compatibility, or fallback path without a `Remove when:` line.
- Production code shaped for tests. Ask for an injected dependency or a
  test-support module.
