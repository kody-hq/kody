/**
 * Typed registry of feature flags. Flags are created and removed only via
 * code review by editing `featureFlagDefinitions`. The database stores
 * runtime state (global toggles/rollouts and per-user overrides), not which
 * flags exist. Removing a key from this array leaves any leftover DB rows
 * visible as "stale" in the admin UI until an operator deletes them.
 *
 * Flags should declare a `successMetric`: the usage metric the flag is
 * expected to move, reviewed in the same PR that creates the flag. Flags
 * with one get exposure recording and an on/off cohort readout on the admin
 * surfaces (see `docs/contributing/architecture/feature-flags.md`). Optional
 * `exposureRecording` selects the write site (`evaluation` chokepoints by
 * default, `mcp-events-clients` for MCP clients that call `events/*` only,
 * or `repo-push-owners` for repo owners on each git push). The
 * `successMetric` field stays optional for flags that are genuinely
 * unmeasurable (such as the permanent `demo-indicator`), and the admin UI and
 * MCP list surface a notice strongly recommending one everywhere else.
 */

import {
	defaultFeatureFlagAudience,
	type FeatureFlagAudience,
} from './audiences.ts'
import { type UsageEventType } from '#universal/usage-event-types.ts'

export type FeatureFlagSuccessMetricMeasure =
	| 'event_count'
	| 'error_rate'
	| 'avg_duration_ms'

export type FeatureFlagSuccessMetric = {
	/** The metered usage event stream this flag is expected to move. */
	eventType: UsageEventType
	/** Which aggregate of that stream the flag is judged against. */
	measure: FeatureFlagSuccessMetricMeasure
	/** The direction the flag is supposed to push the measure. */
	goal: 'increase' | 'decrease'
	/** One human sentence stating the hypothesis behind the flag. */
	hypothesis: string
}

/**
 * Where success-metric exposures are written for a measured flag.
 *
 * - `evaluation` (default): app session cache + MCP caller flag resolver.
 * - `mcp-events-clients`: only from the `registerMcpEvents` `events/*`
 *   handlers; execute and other MCP callers stay out.
 * - `repo-push-owners`: only from the plain-repo git proxy on each
 *   receive-pack, attributed to the repo owner (repo-scoped flags).
 */
export type FeatureFlagExposureRecording =
	| 'evaluation'
	| 'mcp-events-clients'
	| 'repo-push-owners'

export type FeatureFlagDefinition = {
	key: string
	description: string
	defaultEnabled: boolean
	/**
	 * Audience used when no global row exists, and as the first-insert
	 * default when an operator enables the flag without an explicit
	 * audience. Omit for `everyone`.
	 */
	defaultAudience?: FeatureFlagAudience
	successMetric?: FeatureFlagSuccessMetric
	/**
	 * Exposure write site for measured flags. Omit for `evaluation`.
	 * Only meaningful when `successMetric` is set.
	 */
	exposureRecording?: FeatureFlagExposureRecording
}

export const featureFlagDefinitions = [
	{
		key: 'demo-indicator',
		defaultEnabled: false,
		description:
			'Reserved for exercising the feature flag system end-to-end. When enabled it shows a small demo indicator in the app UI. Safe to toggle.',
		// Intentionally no successMetric: this permanent flag exists to
		// exercise the flag system itself (including the "no success metric"
		// admin notice), not to move a product metric.
	},
	{
		key: 'profiles',
		defaultEnabled: false,
		defaultAudience: 'experiments_opt_in',
		description:
			'Profiles (ADR 0092): scoped identities a person creates for agents and bots, with snapshot grants capped by the parent chain, shorten-only expiry, and terminal revoke. Off by default; experimenters opt in at /account/experiments. Delete the flag and gate sites when profiles graduate.',
		successMetric: {
			eventType: 'execute',
			measure: 'event_count',
			goal: 'increase',
			hypothesis:
				'Experimenters who create profiles give their agents narrower identities and keep executing through them.',
		},
	},
	{
		key: 'mcp-skills-extension',
		defaultEnabled: false,
		defaultAudience: 'experiments_opt_in',
		description:
			'Skills-over-MCP (SEP-2640) for package-shipped Agent Skills: packages may ship `skills/<name>/SKILL.md`, and when an MCP client advertises the skills extension Kody exposes those skills via skills/list, skills/get, and resources/read as a progressive enhancement. Signed-in users can opt in from /docs/package-skills; enable for experimenters via admin (adminFeatureFlagSet with audience experiments_opt_in). Off by default. Delete the flag and gate sites when the experiment ends.',
		successMetric: {
			eventType: 'execute',
			measure: 'event_count',
			goal: 'increase',
			hypothesis:
				'Skill-aware hosts that load package skills over MCP then act via execute, so experimenters with the extension on run more execute calls against skill-guided packages.',
		},
	},
	{
		key: 'mcp-events-extension',
		defaultEnabled: false,
		defaultAudience: 'experiments_opt_in',
		description:
			'MCP Events extension (draft, webhook delivery only) on the stateless /mcp lane: advertise the events capability and serve events/list, events/subscribe, and events/unsubscribe for package kody.emits topics that opt in with mcp: true. OAuth callers only; clients declare nothing. Off by default; enable with audience experiments_opt_in. Signed-in users can also turn it on from /docs/mcp-events. Delete the flag and gate sites when the experiment ends.',
		exposureRecording: 'mcp-events-clients',
		successMetric: {
			eventType: 'execute',
			measure: 'event_count',
			goal: 'increase',
			hypothesis:
				'Experimenters whose MCP clients subscribe to package events run more event-driven execute calls than comparable flag-off users.',
		},
	},
	{
		key: 'package-credential-suppliers',
		defaultEnabled: false,
		description:
			'Gate publisher- and executor-supplied package credentials, including visitor grant mappings. Off by default. Delete this flag after the follow-up removes supplier aliases and legacy paths.',
		// Intentionally no successMetric: a credential authority boundary, not
		// a product experiment.
	},
	{
		key: 'repo-push-queue',
		defaultEnabled: false,
		defaultAudience: 'experiments_opt_in',
		description:
			'Per-repo Durable Object write queue for plain-repo git pushes (git-receive-pack): pushes land in the kody-push-queue Worker (RepoPushQueueV1) and reach Artifacts one at a time in FIFO order, with a 90s per-push budget and a clean 503 + Retry-After instead of a raw busy error. Evaluated per repo: repo allowlist (adminFeatureFlagRepoOverride), then the repo owner override, then the global switch with percentage rollout bucketed by repo, then the audience gate on the repo owner. Off repos keep the isolate-local wait-and-retry proxy. Kept as a kill switch after the global rollout. Every push records an observe-only git_push usage event (path, outcome, Durable Object wall time, wait, queue depth, attempts) and an exposure for the repo owner; read queue cost with adminRepoPushQueueCost.',
		exposureRecording: 'repo-push-owners',
		successMetric: {
			eventType: 'git_push',
			measure: 'error_rate',
			goal: 'decrease',
			hypothesis:
				'Pushes to repos on the per-repo push queue fail with busy, timeout, or other errors less often than pushes through the isolate-local wait-and-retry proxy.',
		},
	},
	{
		key: 'execution-contexts',
		defaultEnabled: false,
		defaultAudience: 'experiments_opt_in',
		description:
			'Execution contexts: run execute on a machine the user registered (their laptop or a build server) instead of Kody cloud, with package-style sharing and a per-user chain. Off by default; enable with audience experiments_opt_in. Delete the flag and gate sites when the feature ships.',
		successMetric: {
			eventType: 'dynamic_worker_day',
			measure: 'event_count',
			goal: 'decrease',
			hypothesis:
				'Runs that go to a registered execution context do not start a cloud Dynamic Worker, so experiment users burn fewer unique worker-days.',
		},
	},
	{
		key: 'credential-need-enforcement',
		defaultEnabled: false,
		description:
			'Global switch (audience and rollout are ignored) for packages that have no credential stamp. When on, a package run by anyone but its author (a team-org package, a Use collaborator, an unadopted community fork, or any internet-visible package) may fill {{secret:…}}, {{integration-token:…}}, and vault placeholders and call credential(key) only for credentials its kody.credentials closure declares; anything else fails with credential_need_undeclared. Packages that stored a credential stamp are limited to those slots whether or not this flag is on (issue #3836). Do not flip this flag to enforce stamped packages: it would also change unstamped packages. Self-publish auto-approval also waits for this flag.',
		// Intentionally no successMetric: a security boundary, not a product
		// metric; the readout is the codemod rescan and credential_need_undeclared errors.
	},
	{
		key: 'credential-allowed-packages-safety-window',
		defaultEnabled: true,
		description:
			"Global switch (audience and rollout are ignored) for the issue #4129 30-day safety window before allowed-packages enforcement cutover. While on and inside the window, nothing is refused for a self-authored or adopted package that a user credential's non-empty allowed-packages list leaves out. A pair whose package and credential both existed before the window started is added to the list on first use (credential.allowed_packages_updated audit row, reason grandfathered for #4129, source safety_window, plus a log line); any other pair is quietly allowed with a log line and keeps its would-block marker. The owner is never notified. From cutover the rule is strict whether or not this flag is on. Delete the flag and gate sites once the window has closed.",
		// Intentionally no successMetric: a credential authority boundary, not
		// a product experiment; the readout is the safety_window audit rows.
	},
] as const satisfies ReadonlyArray<FeatureFlagDefinition>

export type FeatureFlagKey = (typeof featureFlagDefinitions)[number]['key']

export const mcpSkillsExtensionFlagKey =
	'mcp-skills-extension' satisfies FeatureFlagKey

export const mcpEventsExtensionFlagKey =
	'mcp-events-extension' satisfies FeatureFlagKey

export const packageCredentialSuppliersFlagKey =
	'package-credential-suppliers' satisfies FeatureFlagKey

export const repoPushQueueFlagKey = 'repo-push-queue' satisfies FeatureFlagKey

export const executionContextsFlagKey =
	'execution-contexts' satisfies FeatureFlagKey

export const profilesFlagKey = 'profiles' satisfies FeatureFlagKey

export const credentialNeedEnforcementFlagKey =
	'credential-need-enforcement' satisfies FeatureFlagKey

export const credentialAllowedPackagesSafetyWindowFlagKey =
	'credential-allowed-packages-safety-window' satisfies FeatureFlagKey

export const featureFlagKeys: ReadonlyArray<FeatureFlagKey> =
	featureFlagDefinitions.map((definition) => definition.key)

const featureFlagDefinitionByKey = new Map<
	FeatureFlagKey,
	FeatureFlagDefinition
>(
	featureFlagDefinitions.map((definition) => [
		definition.key,
		definition as FeatureFlagDefinition,
	]),
)

/**
 * Registry flags that declare a success metric. Only these flags get
 * exposure recording and admin metric readouts.
 */
const measuredFeatureFlagDefinitions: ReadonlyArray<
	FeatureFlagDefinition & { successMetric: FeatureFlagSuccessMetric }
> = (featureFlagDefinitions as ReadonlyArray<FeatureFlagDefinition>).filter(
	(
		definition,
	): definition is FeatureFlagDefinition & {
		successMetric: FeatureFlagSuccessMetric
	} => definition.successMetric !== undefined,
)

export const measuredFeatureFlagKeys: ReadonlySet<FeatureFlagKey> = new Set(
	measuredFeatureFlagDefinitions.map(
		(definition) => definition.key as FeatureFlagKey,
	),
)

/**
 * Shared notice shown by the admin UI and the `adminFeatureFlagList`
 * capability for registry flags that do not declare a success metric.
 */
export const missingSuccessMetricNotice =
	'No success metric declared. Strongly recommended: add a successMetric to this flag in packages/worker/universal/feature-flags/registry.ts so exposures are recorded and the on/off cohort readout can show whether the flag is moving the metric it exists for.'

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
	return featureFlagDefinitionByKey.has(value as FeatureFlagKey)
}

export function getFeatureFlagDefinition(
	key: FeatureFlagKey,
): FeatureFlagDefinition {
	const definition = featureFlagDefinitionByKey.get(key)
	if (!definition) {
		throw new Error(`Unknown feature flag key: ${key}`)
	}
	return definition
}

export function getFeatureFlagDefaultAudience(
	key: FeatureFlagKey,
): FeatureFlagAudience {
	return (
		getFeatureFlagDefinition(key).defaultAudience ?? defaultFeatureFlagAudience
	)
}

/**
 * Where exposures are written for a measured flag. Unmeasured flags never
 * record exposures; measured flags default to the evaluation chokepoints.
 */
export function getFeatureFlagExposureRecording(
	key: FeatureFlagKey,
): FeatureFlagExposureRecording {
	const definition = getFeatureFlagDefinition(key)
	if (!definition.successMetric) return 'evaluation'
	return definition.exposureRecording ?? 'evaluation'
}

/**
 * True when the app/MCP evaluation chokepoints should write an exposure for
 * this measured flag. Flags with a dedicated recording site (for example
 * events-capable MCP clients) return false here and record only on that path.
 */
export function recordsFeatureFlagExposureAtEvaluation(
	key: FeatureFlagKey,
): boolean {
	return (
		measuredFeatureFlagKeys.has(key) &&
		getFeatureFlagExposureRecording(key) === 'evaluation'
	)
}
