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

1. Per-user override row (wins over everything, including audience).
2. Global row: off → off; on with `rollout_percent` set → deterministic FNV-1a
   bucket of `key:userId` compared to the percentage (anonymous users are
   excluded from percentage rollouts); on without a percentage → on.
3. Registry `defaultEnabled`.
4. **Audience gate** (when the effective audience is not `everyone`): if the
   evaluation would be on and the audience is `experiments_opt_in`, the user
   must have `users.experiments_opt_in = 1` (set from `/account/experiments`).
   Otherwise the flag stays off and keeps the same assignment source. The
   effective audience is the global row's `audience`, or the registry
   `defaultAudience` (`everyone` when omitted) when there is no global row.

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
3. Global row, with `rollout_percent` bucketed by `key:sourceId` (source ids are
   stable; repo names are neither unique nor permanent).
4. Registry `defaultEnabled`.
5. Audience gate against the repo owner (stable user id or personal org id).

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
  (`feature_flag_*` actions).
- **MCP capabilities**: `adminFeatureFlagList`, `adminFeatureFlagSet`,
  `adminFeatureFlagOverride` (admin role required, audited).
- **Client**: evaluated per-request in `loadSessionInfo` (cached per request in
  `request-feature-flags-cache.ts`) and shipped as `session.featureFlags`; gate
  UI with `isFeatureFlagEnabled(session, key)` from
  `packages/worker/client/feature-flags.ts`.
- **Capability gating**: a capability definition may declare
  `featureFlag: <key>`; `access-control.ts` hides it from search and denies
  execution when the flag evaluates off for the caller. Flag-gated capabilities
  require an authenticated caller whose stable id resolves to a `users.id`;
  anonymous callers, unresolvable identities, missing flag maps, and evaluation
  failures all fail closed. The flag map is only resolved when the registry
  actually contains a gated capability.

The registry ships with one permanent flag, `demo-indicator`, which renders a
small badge in the app chrome and exists so the system stays exercised
end-to-end (`e2e/admin-feature-flags.spec.ts`). Experiment flags live in the
same registry and are removed in the same way: delete the definition and every
gate site.

`jev-search-rerank` is a kill switch (default **off**, registry
`defaultAudience: experiments_opt_in`) for improved ranked MCP
`search({ query })`. When the flag is on, **paid** plans (`standard` / `pro` /
`max`) widen hybrid recall and may run Workers AI `typesafe/jev` Score through
AI Gateway when the post-hybrid pool looks ambiguous. Free and anonymous never
call Jev. The plan gate is a **feature gate**, not an entitlement / usage
counter. Pricing-page “improved search” copy is gated by the same flag
(`isFeatureFlagEnabled` on the session) so the claim is not visible while the
experiment is off. Offline/deterministic search skips Jev and uses hybrid order.
See [Search](../../use/search.md) for skip reasons, telemetry, and Gateway
requirements.

**Success-metric exposure (F5):** this flag sets
`exposureRecording: 'paid-ranked-search'`. Exposures are **not** written at the
generic app/MCP evaluation chokepoints. They are written after list-mode search
completes a **ranked** path (when `telemetry.jevRerank` is present) for **paid**
users only: `on` when the same flag evaluation that gated search is enabled
(Jev-eligible — necessity may still skip Score), `off` when it is disabled.
Empty query / domain index / domain overview short-circuits stay outside the
frame. Free and anonymous searchers are outside the frame. Assignment `source`
still comes from that evaluation, so override dogfood is tagged and excluded
from on/off (shown as the override cohort). Enable for dogfood with
`adminFeatureFlagOverride({ key: "jev-search-rerank", username: "kentcdodds", enabled: true })`
or via experiments opt-in while the global audience is `experiments_opt_in`.
Remove the flag and gate sites when the experiment ends.

`execute-invoke` is an experiment (default **off**, registry
`defaultAudience: experiments_opt_in`) for the MCP `execute` `invoke` shortcut.
When on for a caller, the execute tool advertises `invoke` (a
`kody:@scope/package/export` specifier) and generates the same thin passthrough
source a careful agent would write, then runs the existing execute path. When
off, `invoke` is omitted from the tool schema and rejected if sent. The declared
`successMetric` is `dynamic_worker_day` event count, goal decrease: stable
invoke-generated graphs should reuse one isolate per package export instead of
burning a unique worker-day per rewritten glue module. Exposures are recorded
when the MCP execute tool is registered (invoke offered). Enable for experiment
members with
`adminFeatureFlagSet({ key: "execute-invoke", enabled: true, audience: "experiments_opt_in" })`.
Remove the flag and gate sites when the experiment ends.

`connection-profiles` is an experiment (default **off**, registry
`defaultAudience: experiments_opt_in`) for named connection profiles on
`/@<slug>/-/agents`. When on, experimenters create profiles with package grant
allowlists (read/execute) for MCP `?profile=` URLs and profile-bound API tokens.
Unlimited (no profile param) is the default connection. When off, the list page
hides profiles and callers without the flag ignore `?profile=`. The declared
`successMetric` is `execute` event count, goal increase: experimenters create
restricted agent connections and keep executing against granted packages.
Exposures are recorded at the evaluation chokepoints. Enable for experiment
members with
`adminFeatureFlagSet({ key: "connection-profiles", enabled: true, audience: "experiments_opt_in" })`.
Remove the flag and gate sites when the experiment ends.

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
[ADR 0059](../decisions/0059-mcp-events-extension-behind-flag.md)). When on for
a caller whose stateless-lane request declares events support in its client
capabilities, `server/discover` advertises `capabilities.events` and the server
answers `events/list`, `events/subscribe`, and `events/unsubscribe`. Only
`kody.emits` topics declared with `mcp: true` are listed. When off (or the
client does not declare events), none of that is registered, and existing
subscriptions stop receiving deliveries. Signed-in users can also turn it on
from `/docs/mcp-events` (a per-user on override). The declared `successMetric`
is `execute` event count, goal increase: event-driven clients follow deliveries
with execute calls. Exposures use `exposureRecording: mcp-events-clients`
(dedicated write from `registerMcpEvents` only), so execute and other non-events
MCP callers stay out of the on/off cohorts. Enable for experiment members with
`adminFeatureFlagSet({ key: "mcp-events-extension", enabled: true, audience: "experiments_opt_in" })`.
Remove the flag and gate sites when the experiment ends.

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
`exposureRecording: 'paid-ranked-search'` (Jev) write only from paid list-mode
ranked search so free opt-ins and non-search traffic stay outside that
experiment frame. The write path mirrors usage metering — the `FLAG_EXPOSURES`
Analytics Engine dataset in production/preview, the D1
`feature_flag_exposure_rollups` table (migration `0001-squashed-init.sql`,
90-day retention) in local dev and tests — and never throws.

The assignment source (`default` / `global` / `rollout` / `override`) is what
keeps the readout honest: `override` users are hand-picked and excluded from
on/off comparisons (their usage is still shown as the override cohort), while
`rollout` users are deterministically bucketed.

### Readout

`success-metric-readout.ts` joins exposures with the usage event stream for the
declared `eventType` over the current UTC month to date, splits users into
on/off cohorts, and aggregates event count, error rate, and average duration per
cohort. Users with any override-sourced exposure are excluded from on/off and
aggregated into `override`. Users who saw both fair values inside the window are
counted as `mixedUsers` and excluded from on/off (month-level usage cannot be
split at the switch without contaminating the later cohort). The admin UI
(`/admin/feature-flags`) and `adminFeatureFlagList` attach this readout to every
measured flag. The comparison is decision support for a human — "keep rolling
out or kill it" stays an operator call, not an automated one.

In production the readout is two Analytics Engine SQL queries. Analytics Engine
rejects the whole query (HTTP 422) when `max()` gets a String column, so the
latest exposure per user is `max(timestamp)`, never `max(blob5)`;
`success-metric-readout.node.test.ts` guards this. A failed query degrades to
`status: 'unavailable'` with the underlying SQL/HTTP error in `reason`.
