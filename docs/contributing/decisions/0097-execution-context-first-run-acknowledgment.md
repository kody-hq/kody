# 0097: A shared execution context needs an acknowledgment before a person's first run

- **Status:** accepted
- **Date:** 2026-11-04
- **Amends:**
  [0096](./0096-execution-context-box-login-and-excess-access-notices.md) (0096
  shipped with notices only; this adds the acknowledgment Kent decided on
  2026-11-03 and confirmed on 2026-11-04)

## Context

0096 records the box login and shows excess-access notices, but a person could
start running on a shared box without ever reading what it runs as. Opting in
covers the machine operator seeing your runs; it does not cover the box login.

## Decision

1. **Who acknowledges.** Every person who runs on a context they don't operate
   and aren't the box login for (a profile login counts as its person). The
   operator and the box login's own person never do.
2. **What they acknowledge.** The box login (person or agent profile, and whose)
   and the excess access it has over them, the same diff as the 0096 notice.
3. **Storage.** `execution_context_acknowledgments`, one row per context, org
   and person: the login principal and the excess entries they saw.
4. **When it is needed again.** When the box login changes (another person or
   profile), or the login gains an entry the person lacks that was not in what
   they acknowledged. Losing excess never needs a new acknowledgment. This
   mirrors when 0096 notices re-raise, so a person is asked again exactly when
   the box can newly do something they could not consent to. Acknowledgments
   never expire.
5. **Only the person.** `executionContextAcknowledge` accepts a web session or
   the person's own `kody login` (CLI) credential and refuses agent profiles,
   API tokens and MCP clients. The caller passes the fingerprint they were
   shown; a stale one is refused so nobody acknowledges what they didn't read.
   The CLI asks at a terminal and has no `--yes`.
6. **Where runs stop.** Routing skips an unacknowledged shared context with
   `acknowledgment_required`, the same as any unusable context:
   - a named context without `fallback: "chain"` fails with
     `no_execution_context_available` and the acknowledgment instructions;
   - a chain moves to its next entry, so it reaches Kody cloud only when the
     chain already ends in cloud (a strict chain fails with the same text).
7. **Dismissal is separate.** Dismissing a 0096 notice does not acknowledge, and
   acknowledging does not dismiss; only the notice's subject dismisses it.

## Consequences

- Existing grantees must acknowledge once before their next run on a shared box;
  the context page, execute errors and the CLI all say how.
- Publish builds and host commands were already operator-only, so they never hit
  the gate.
