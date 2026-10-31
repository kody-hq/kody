# Feature flags

Admin-managed toggles for gating features while they are developed. Flags answer
exactly one question — "is this feature shipped for this user yet?" — and
deliberately overlap with nothing else: RBAC answers "who may do what" and
entitlements answer "who is allowed how much".

Modules: `packages/worker/universal/feature-flags/` (registry and transport
types) and `packages/worker/src/feature-flags/` (D1 evaluation and admin
mutations).

- `universal/feature-flags/registry.ts` — the typed flag registry
  (`featureFlagDefinitions`, `FeatureFlagKey`). Flags are created and removed
  only via code review by editing this array; every gate site is compile-checked
  against it. Flags should also declare a `successMetric` (see below). Optional
  `defaultAudience` (`everyone` when omitted) is used when no global row exists
  and as the first-insert default when an operator enables a flag without an
  explicit audience.
- `universal/feature-flags/types.ts` — dependency-free transport types shared
  with the client bundle.
- `service.ts` — evaluation (`isFeatureEnabled`, `getFeatureFlagsForUser`,
  `getFeatureFlagEvaluationsForUser` with assignment sources) and admin
  mutations (global state, per-user overrides, stale cleanup).
- `exposure.ts` — success-metric exposure recording (which value each user saw
  and how it was assigned).
- `success-metric-readout.ts` — the on/off cohort metric readout for the admin
  surfaces.

## The registry-owns-existence invariant

The database stores **state**, never **existence**. The squashed baseline
(`packages/worker/migrations/0001-squashed-init.sql`) defines two tables, later
extended by `0065-experiments-opt-in.sql`:

- `feature_flags` — at most one global row per key: `enabled`, `rollout_percent`
  (nullable), `audience` (`everyone` | `experiments_opt_in`, default
  `everyone`), `note`, `updated_by`, `updated_at`. No row means "use the
  registry default" with the registry `defaultAudience` (`everyone` when
  omitted).
- `feature_flag_user_overrides` — per-user forced on/off, keyed by
  `(flag_key, user_id)`, cascade-deleted with the user and covered by account
  export/deletion targets.
- `users.experiments_opt_in` — account preference (0/1) for the
  `experiments_opt_in` flag audience, edited at `/account/experiments`.

- `feature_flag_repo_overrides` — per-repo forced on/off for repo-scoped flags,
  keyed by `(flag_key, source_id)` (migration 0148). No foreign keys, so a table
  rebuild cannot cascade away rollout state; overrides for deleted sources are
  inert.

Removing a flag from the registry breaks the build at every remaining gate site;
leftover DB rows for removed keys surface as **stale** in the admin UI
(delete-only — `deleteStaleFeatureFlag` refuses keys still in the registry).

## Evaluation precedence

1. Per-user override row (wins over everything, including audience). Explicit
   off works.
2. Per-org row for the org context (`feature_flag_org_overrides`, keyed by
   stable `orgs.id`). Wins over the global row and the audience gate, on or off.
   Applies only to live members of an active org (or the personal org's owner).
   See [ADR 0084](../decisions/0084-org-feature-flag-rows.md).
3. Global row: off → off; on with `rollout_percent` set → deterministic FNV-1a
   bucket of `key:userId` compared to the percentage (anonymous users are
   excluded from percentage rollouts); on without a percentage → on.
4. Registry `defaultEnabled`.
5. **Audience gate** (when the effective audience is not `everyone`): if the
   evaluation would be on and the audience is `experiments_opt_in`, the user
   must have `users.experiments_opt_in = 1` (set from `/account/experiments`).
   Otherwise the flag stays off and keeps the same assignment source. The
   effective audience is the global row's `audience`, or the registry
   `defaultAudience` (`everyone` when omitted) when there is no global row.

### Org context

`evaluateFeatureFlag(db, key, userId, { orgId })`,
`getFeatureFlagEvaluationsForUser(db, userId, { orgId })`, and
`isFeatureEnabled(...)` take the org of the request or run. A user in several
orgs is evaluated only against that org, never against all memberships. Passing
`null` (the default) means no org context: org rows do not apply.

| Surface                                       | Org context                                                      |
| --------------------------------------------- | ---------------------------------------------------------------- |
| MCP, `execute`, Open API (caller resolver)    | `callerContext.request.org` (org binding, else the personal org) |
| Website session flags (`/session`, SSR shell) | the matched route's org scope (`/@slug/-/...`); none elsewhere   |
| Execution contexts                            | the request org, or the `/@slug` org of the page                 |
| Credential suppliers                          | the org that owns the credential                                 |
| Repo-scoped flags                             | the org that owns the repo (personal org for personal repos)     |
| MCP event fan-out                             | none (user only)                                                 |

Evaluated-flag caches key on user and org (`stableUserId` plus org id in the MCP
resolver; page org slug in the per-request app cache and in the website shell
query key).

Evaluation failures for authenticated users **fail closed** (all flags off) so a
default-on flag can never bypass an operator kill switch when D1 is unavailable.

### Repo-scoped flags

Some flags gate a repo rather than a user (for example `repo-push-queue`, which
routes a repo's `git-receive-pack` through the `kody-push-queue` Durable
Object). `evaluateRepoFeatureFlag(db, key, { sourceId, ownerId })` in
`packages/worker/src/feature-flags/repo-flags.ts` resolves:

1. Per-repo override row (the allowlist; wins over everything, including
   audience).
2. The repo owner's per-user override.
3. The org row for the org that owns the repo (the personal org for personal
   repos).
4. Global row, with `rollout_percent` bucketed by `key:sourceId` (source ids are
   stable; repo names are neither unique nor permanent).
5. Registry `defaultEnabled`.
6. Audience gate against the repo owner (stable user id or personal org id).

Operate it with `adminFeatureFlagRepoOverride({ key, sourceId, enabled })` (or
`clear: true`) and inspect with `adminFeatureFlagRepoCheck({ key, sourceId })`;
both are admin-only and audited. Like every `admin` capability they are
execute-only (no Open API operation, so `kody api <operationId>` rejects them):
call `kody.adminFeatureFlagRepoCheck(...)` from `execute` / `kody execute`.
`sourceId` is the `{id}` in `/git/sources/{id}.git` (`repoGetGitRemote`
`source_id`), not the `repo_id` from `repoList`.

### Experiments audience

Signed-in users opt in or out at `/account/experiments` (`updateExperiments`
with `{ experimentsOptIn: boolean }`). That writes `users.experiments_opt_in`.
Operators then target that audience on a flag:

- **Admin UI**: `/admin/feature-flags` → Audience → “Experiments opt-in”.
- **MCP**:
  `adminFeatureFlagSet({ key, enabled: true, audience: "experiments_opt_in" })`.

Audience values: `everyone` (default) | `experiments_opt_in`.

## Surfaces

- **Admin UI**: `/admin/feature-flags` (Start server functions in
  `admin-mutations.ts`), admin-role gated, audited via `logAuditEvent`
  (`feature_flag_*` actions). Each flag card has an Organization overrides panel
  (by org handle) next to User overrides.
- **MCP capabilities**: `adminFeatureFlagList`, `adminFeatureFlagSet`,
  `adminFeatureFlagOverride`, `adminFeatureFlagOrgOverride` (`{ key, orgId }` or
  `{ key, orgSlug }` with `enabled` and an optional `note`, or `clear: true`)
  (admin role required, audited, `contextRuns: 'deny'`).
- **Client**: evaluated per-request in `loadSessionInfo` (cached per request in
  `request-feature-flags-cache.ts`) and shipped as `session.featureFlags`; gate
  UI with `isFeatureFlagEnabled(session, key)` from
  `packages/worker/client/feature-flags.ts`.
- **Execute fetch gateway**: each `KodyFetchGateway` call gets freshly
  deserialized props, so request-keyed memos miss across one execution's
  fetches. The host sets `executionId` on the run's gateway props, and
  `feature-flags/execution-scope.ts` reuses `evaluateFeatureFlag`,
  `isFeatureGloballyEnabled`, and the supplier flag's org-owner lookup for that
  id (KODY-CS). The next execution gets a new id and reads D1 again. Only
  settled reads cross gateway calls: each call is its own Workers request, and
  one awaiting another's in-flight read is cancelled as hung.
- **Capability gating**: a capability definition may declare
  `featureFlag: <key>`; `access-control.ts` hides it from search and denies
  execution when the flag evaluates off for the caller. Flag-gated capabilities
  require an authenticated caller whose stable id resolves to a `users.id`;
  anonymous callers, unresolvable identities, missing flag maps, and evaluation
  failures all fail closed. The flag map is only resolved when the registry
  actually contains a gated capability.

The registry ships with one permanent flag, `demo-indicator`, which renders a
small badge in the app chrome and exists so the system stays exercised
end-to-end. Experiment flags live in the same registry and are removed in the
same way: delete the definition and every gate site.

`mcp-skills-extension` is an experiment (default **off**, registry
`defaultAudience: experiments_opt_in`) for Skills-over-MCP (SEP-2640). Packages
may ship Agent Skills at `skills/<name>/SKILL.md`; publish validates them and
stores a per-package-version skills index. When on for a caller and the MCP
client advertises the skills extension, Kody exposes those skills through
`skills/list`, `skills/get`, and `resources/read` as a progressive enhancement.
When off (or the client does not advertise the extension), the MCP surface stays
`search` / `execute` / `api`. Signed-in users can opt themselves in from
`/docs/package-skills`. The declared `successMetric` is `execute` event count,
goal increase: skill-aware hosts load package skills, then act via `execute`.
Enable for experiment members with
`adminFeatureFlagSet({ key: "mcp-skills-extension", enabled: true, audience: "experiments_opt_in" })`.
Remove the flag and gate sites when the experiment ends.

`mcp-events-extension` is an experiment (default **off**, registry
`defaultAudience: experiments_opt_in`) for the draft MCP Events extension
(webhook delivery only; see
[ADR 0059](../decisions/0059-mcp-events-extension-behind-flag.md) and
[ADR 0087](../decisions/0087-mcp-events-no-client-declaration.md)). When on for
an OAuth caller on the stateless lane, `server/discover` advertises
`capabilities.events` and the server answers `events/list`, `events/subscribe`,
and `events/unsubscribe`. Clients declare nothing. Only `kody.emits` topics
declared with `mcp: true` are listed. When off (or the caller is not an OAuth
principal), none of that is registered, and existing subscriptions stop
receiving deliveries. Signed-in users can also turn it on from
`/docs/mcp-events` (a per-user on override). The declared `successMetric` is
`execute` event count, goal increase: event-driven clients follow deliveries
with execute calls. Exposures use `exposureRecording: mcp-events-clients`
(dedicated write from the `registerMcpEvents` `events/*` handlers only), so
execute and other non-events MCP callers stay out of the on/off cohorts. Enable
for experiment members with
`adminFeatureFlagSet({ key: "mcp-events-extension", enabled: true, audience: "experiments_opt_in" })`.
Remove the flag and gate sites when the experiment ends.

`repo-push-queue` is the repo-scoped kill switch for the per-repo push queue
([ADR 0075](../decisions/0075-repo-push-queue-worker.md)); it stays in the
registry after the global rollout so operators can turn the queue off. Its
`successMetric` is the observe-only `git_push` event, `error_rate`, goal
decrease: pushes should stop failing with busy (`503` + `Retry-After`), timeout
(the queue's 90s budget), or other errors. Every receive-pack through the
plain-repo git proxy records one `git_push` event for the repo owner
(`entity_sources.user_id`, a person's stable id or an org id) with entity id
`queued` or `direct`, the outcome and error name, wall time (the Durable
Object's own wall time for queued pushes), wait before the first Artifacts send,
queue depth on arrival, and Artifacts attempts. Exposures use
`exposureRecording: 'repo-push-owners'`: the proxy writes one per push for the
repo owner with the same evaluation that routed it, so the readout joins
exposures and pushes on the owner id. An owner whose repos saw both values in
the window counts as mixed, and owners with an allowlisted repo
(`adminFeatureFlagRepoOverride`, source `override`) or an owner override land in
the override cohort. Pushes on a deploy without the `REPO_PUSH_QUEUE` binding
(local dev) or where flag evaluation failed record `git_push` but no exposure.
Queue cost numbers (per path: ok/busy/timeout/error counts and rates, average
and max wall time, total wall seconds, wait, attempts and busy retries, queue
depth) come from `adminRepoPushQueueCost({ days })`, which returns aggregates
only (never owners, usernames, or repo ids). Production writes go only to
Analytics Engine; there is no per-push D1 write.

## Success metrics

Every flag exists to move something; the `successMetric` field on a registry
definition states what, in code review, alongside the flag itself:

```ts
successMetric: {
	eventType: 'execute', // a UsageEventType from usage metering
	measure: 'error_rate', // 'event_count' | 'error_rate' | 'avg_duration_ms'
	goal: 'decrease',
	hypothesis: 'One human sentence stating why this flag should move it.',
}
```

The field is compile-checked against the closed `UsageEventType` union
(`packages/worker/universal/usage-event-types.ts`), so a flag can only be judged
against a metric the usage-metering pipeline already collects. It stays optional
for genuinely unmeasurable flags (like the permanent `demo-indicator`), but the
admin UI and the `adminFeatureFlagList` capability render a notice strongly
recommending one everywhere else.

### Exposures

Current flag state cannot reconstruct who was inside a percentage rollout last
week, so measured flags record **exposures** at their configured write site
`(stable user id, flag key, on/off, assignment source, timestamp)`. Most flags
use the two evaluation chokepoints (the app session flag cache and the MCP
caller flag resolver). The app session cache records **once per HTTP request**.
The MCP resolver records when it loads a user's evaluations, at most **once per
15 second TTL per isolate**, and call sites in that window reuse the evaluation.
Stateless `/mcp` builds a new caller context per request, so this replaces the
old 2–4 exposure writes per tools/call. **Lower exposure counts are expected and
more accurate**: they count the assignment the user saw, not each call site or
each stateless request inside the window. A kill switch or override can be stale
until the TTL expires. Evaluation failures are not cached and fail closed (every
flag off) without an exposure write, and execute refuses before loading a
worker, so the failure never spends daily quota. Flags with
`exposureRecording: 'mcp-events-clients'` write only when an MCP client calls an
`events/*` method, so other MCP callers stay outside that experiment frame.
Flags with `exposureRecording: 'repo-push-owners'` (`repo-push-queue`) write
only from the plain-repo git proxy, once per push, for the repo owner. The write
path mirrors usage metering — the `FLAG_EXPOSURES` Analytics Engine dataset in
production/preview, the D1 `feature_flag_exposure_rollups` table (migration
`0001-squashed-init.sql`, 90-day retention) in local dev and tests — and never
throws.

The assignment source (`default` / `global` / `rollout` / `override` / `org`) is
what keeps the readout honest: `override` and `org` users are hand-picked and
excluded from on/off comparisons (their usage is still shown as the override and
org override cohorts), while `rollout` users are deterministically bucketed.

### Readout

`success-metric-readout.ts` joins exposures with the usage event stream for the
declared `eventType` over the current UTC month to date, splits users into
on/off cohorts, and aggregates event count, error rate, and average duration per
cohort. Users with any override-sourced exposure are excluded from on/off and
aggregated into `override`; users with org-sourced exposures (and no user
override) go to `orgOverride`. Users who saw both fair values inside the window
are counted as `mixedUsers` and excluded from on/off (month-level usage cannot
be split at the switch without contaminating the later cohort). The admin UI
(`/admin/feature-flags`) and `adminFeatureFlagList` attach this readout to every
measured flag. The comparison is decision support for a human — "keep rolling
out or kill it" stays an operator call, not an automated one.

In production the readout is two Analytics Engine SQL queries. Analytics Engine
rejects the whole query (HTTP 422) when `max()` gets a String column, so the
latest exposure per user is `max(timestamp)`, never `max(blob5)`;
`success-metric-readout.node.test.ts` guards this. A failed query degrades to
`status: 'unavailable'` with the underlying SQL/HTTP error in `reason`.
