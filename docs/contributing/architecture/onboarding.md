# Onboarding process

The signed-in `/onboarding` wizard, the derived setup checklist, and the
optional first-win email guide share one contract:

[`packages/worker/universal/onboarding-process.ts`](../../../packages/worker/universal/onboarding-process.ts)

| Surface                                  | Role                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| Wizard index `/onboarding`               | Redirects to the first unfinished step (Step 3 once Step 2 is done)                       |
| Wizard Step 1 `/onboarding/step-1`       | Connect an MCP host                                                                       |
| Wizard Step 2 `/onboarding/step-2`       | Make something useful (one prompt + first `search` + `guide:onboarding` first-win picker) |
| Wizard Step 3 `/onboarding/step-3`       | Connect a second ecosystem (connected hosts stay selectable; `guide:portability`)         |
| Checklist                                | Verify email, complete the three wizard steps, then persist a package                     |
| [`first-win`](../../guides/first-win.md) | Optional email → reply → memories loop after a host is connected                          |

Step 2 is one copy-paste prompt that tells the connected agent to retrieve
[`onboarding`](../../guides/onboarding.md)
(`search({ entity: "guide:onboarding" })`). The guide presents six concrete
first-win choices (PR readiness, an always-on ping, skill→owned package, email
wake when the host can be woken, Slack/Raycast webhook, or something else) and
the agent does one small win from their pick. The page shows a spinner until
Kody observes that first successful `search` (or an existing access win: memory,
execute, or saved package). Leftover `/onboarding/step-2/:service` URLs redirect
to Step 2. Leftover `/onboarding/step-3/not-listed` URLs return to the Step 3
ecosystem picker. Below the prompt, Step 2 lists one-click built-in connects
from a short ordered allowlist in code
(`onboardingFeaturedPlatformIntegrationSlugs`). Only built-ins that are
published and enabled, and that the user has not connected yet, appear, so the
list is empty while every built-in is draft. See
[OAuth integrations](./integrations.md#enabled-and-visibility).

Step 3 groups the agent picker by ecosystem (Grok, Claude, ChatGPT, and the
rest). Cursor Local and Cursor Cloud are separate tabs when the grant redirect
shows which surface authorized. An unclassified Cursor grant (client name
Cursor, no surface on the grant redirect) counts as the Grok ecosystem and
disables neither Local nor Cloud. A Cursor Cloud grant also marks Grok Bot
connected. Cursor Local, Cursor Cloud, Grok Bot, Grok.com, and Grok CLI sit in
that Grok ecosystem. Already-connected hosts keep a Connected badge and stay
selectable so connect steps can be re-viewed (second login, new machine,
reinstall). After the person picks a host, a short portability-proof prompt is
folded into the same step so the new agent looks up
[`portability`](../../guides/portability.md)
(`search({ entity: "guide:portability" })`) and reuses what Step 2 made. When
the onboarding payload has a known memory subject or saved-package name, Step 3
shows a short "You made …" chip (truncated subject and `@scope/kody-id`, or
hidden if nothing sensible). `hasSecondMcpClient` is two known ecosystems, not
raw grant count, not unique `clientId`s, and not attribution to the selected
host — Cursor hosts and Grok hosts are one ecosystem, and an unlabeled client
does not count as its own. The connected label stays "You've connected a second
agent." When the second-agent Pro gift is active, that status adds "Pro is free
for 2 weeks." Step 3 copy advertises "Connect a second agent and get Pro free
for 2 weeks." `/onboarding` resumes at that step instead of always opening the
Step 1 picker. The Step 1 and Step 3 pickers, and Step 2, list already-connected
hosts so a return visit cannot hide Cursor or Claude Desktop. A selected-agent
card names only that host: another client's connection does not mark this one
connected and does not put its logo on the card. A remembered picker choice is
not a grant. When a different host actually authorized, Step 2 and Step 3 follow
that grant instead of the pick. Account → Agents (`/@<slug>/-/agents`) lists
those inbound hosts grouped by display name, with public logos for known kinds,
newest-first sort, best-effort labels, per-`clientId` revoke, and **View connect
steps** for known kinds (same install path as Connect an agent). That list is
not `users.mcp_client_name` (first-touch) and not `/account/mcp-oauth-clients`
(user-minted confidential clients).

The gift ledger is written at OAuth authorization completion. Website reads only
load that ledger. The `second_agent_gift_reconciliation` scheduled lane repairs
missed evaluations and older eligible accounts using the existing five-minute
jobs dispatch. It scans eight ungranted live people per tick and wraps its
independent `OAUTH_KV` cursor. At N ungranted people, a full sweep takes roughly
`5 × ceil(N / 8)` minutes, plus a tail tick for an exact batch multiple; failed
people retry on the next sweep. Normal authorization grants remain immediate.
The D1 conditional write prevents replay from extending a gift, and excludes
people or orgs whose deletion began while grants were loading. The cursor is
only a progress hint, so stale KV reads can repeat work safely. See
`src/entitlements/second-agent-gift-reconciliation.ts` in the worker package.

`first-win` is not a wizard step and is not a checklist item. Signed-in
`/onboarding` does not probe Mailbox for that loop. MCP registers
`onboarding_first_win` and `search({ entity: "guide:first_win" })` serves the
guide.

Waiting (`/@<slug>/-/waiting` and `waitingSummary`) is a separate current-state
queue. Wizard-resume and first-use cards live there. See
[Waiting](../../use/waiting.md).

## Alignment check

`packages/worker/universal/onboarding-process.node.test.ts` (part of
`npm run test:node` / `npm run validate`) requires `docs/guides/first-win.md` to
name each current wizard step (label or path). `docs/guides/quick-example.md`
names Step 2's label and the Step 1 path. The first-run briefing is
`docs/guides/onboarding.md` and must name the six first-win choices.

Change the wizard in `onboarding-process.ts` first, then update those two guides
until the test passes. The same check requires `docs/guides/portability.md` to
name Step 3 and stay short. The checklist union has no first-win items; adding
them fails the same check.
