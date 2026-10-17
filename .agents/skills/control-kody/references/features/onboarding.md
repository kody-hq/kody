# Onboarding

Three-step wizard after signup: connect an agent, make something useful (one
prompt plus first search; the onboarding guide offers six first-win choices),
then connect a second agent from a different ecosystem. Step 3 advertises Pro
free for 2 weeks once a second known ecosystem is connected, pastes a
portability-guide prompt, and, when the payload has a known memory subject or
package name, shows a short "You made …" chip.

## How to get there

Signed-in visit to `/onboarding` (resumes at the first unfinished step; finished
accounts land on Step 3 so connected agents stay visible). Step 1 is
`/onboarding/step-1` (optional `:agent`). Step 2 is `/onboarding/step-2`. Step 3
is `/onboarding/step-3` (optional `:agent`). Leftover
`/onboarding/step-2/:service` URLs redirect to Step 2. Leftover
`/onboarding/step-3/not-listed` URLs return to the Step 3 ecosystem picker. Also
linked from account.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /onboarding
```

The page uses native Start server functions for website reads and mutations. Use
supported MCP capabilities through `control-kody search` and
`control-kody execute` when fixture data is needed.

Check all three step pages and dismiss the checklist through its browser
control. Refresh to verify the saved state.

## Gotchas

- `/onboarding` screenshots come from the real origin after
  `control-kody doctor` and `dev:ensure`. `dev:ensure` waits for a starting
  leftover instead of killing it mid-reload. Do not dump one onboarding
  component to static HTML.
- Step 3 completion is two known agent ecosystems. Cursor Local, Cursor Cloud,
  Grok Bot, Grok.com, and Grok CLI sit in the Grok ecosystem. Disable a tab when
  a grant names that host. An unlabeled client adds no ecosystem, and the other
  tabs stay available. A Cursor Cloud grant also marks Grok Bot connected.
  Account → Connections is the grouped inbound list (logos for known kinds,
  newest-first). That first second ecosystem also records the one-time 14-day
  Pro gift (`secondAgentStandardGift` in the native onboarding read).
- The Discord invite sits below the step wizard. First-use setup (search,
  memory, execute, package, job, integration, secret, Discord membership) is on
  Waiting.
- Step 2 lists featured built-in connects only when those slugs are published
  and enabled. The list is empty while every built-in is draft.
