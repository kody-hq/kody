import {
	executionContextsFlagKey,
	featureFlagDefinitions,
	mcpEventsExtensionFlagKey,
	mcpSkillsExtensionFlagKey,
	profilesFlagKey,
	type FeatureFlagKey,
} from './registry.ts'

/**
 * Self-serve experiments: feature flags a signed-in person may turn on or off
 * for themselves. This list drives the `/account/experiments` catalog, the
 * docs-page callouts, the flag-off feature pages, and the `experimentList` /
 * `experimentSet` capabilities. Adding a self-serve experiment means adding an
 * entry here, a `docs/guides/<docsSlug>.md` page, and a
 * `docs/use/<docsSlug>.md` field reference (`experiments.node.test.ts` fails
 * otherwise).
 */
export type SelfServeExperiment = {
	/** Stable id used in URLs, server functions, and capabilities. */
	id: string
	flagKey: FeatureFlagKey
	title: string
	/** Plain-language one or two sentences: what you get. */
	summary: string
	/** `/docs/<docsSlug>` user doc. */
	docsSlug: string
	/** How finished it is, in words a person can act on. */
	stage: string
	/**
	 * Where the feature lives once on, as an org section (`/@slug/-/<section>`)
	 * when it has a page of its own.
	 */
	orgSection?: string
}

export const selfServeExperiments = [
	{
		id: 'execution-contexts',
		flagKey: executionContextsFlagKey,
		title: 'Execution contexts',
		summary:
			'Run execute and automations on your own machine or a build server instead of Kody cloud, with access to the folders and local network you allow. Credentials stay in Kody cloud.',
		docsSlug: 'execution-contexts',
		stage:
			'Early access: register a machine, set a chain, and fall back to Kody cloud.',
		orgSection: 'execution-contexts',
	},
	{
		id: 'profiles',
		flagKey: profilesFlagKey,
		title: 'Profiles',
		summary:
			'Give an agent or bot its own identity in an org, with only the access you hand it, an optional expiry, and sub-profiles for the agents it starts. A profile only reaches what you and every parent profile granted it, including packages shared with it from their Collaborators tab.',
		docsSlug: 'profiles',
		stage:
			'Early access: mint a token for a profile (tokenCreate profile_id) or hand a sub-agent its own sub-profile (profileHandoff).',
	},
	{
		id: 'package-skills',
		flagKey: mcpSkillsExtensionFlagKey,
		title: 'Package skills over MCP',
		summary:
			'Serve the Agent Skills your packages ship (skills/<name>/SKILL.md) to MCP hosts that support Skills over MCP. Publishing skills works without this.',
		docsSlug: 'package-skills',
		stage: 'Draft MCP extension: host support is partial.',
	},
	{
		id: 'mcp-events',
		flagKey: mcpEventsExtensionFlagKey,
		title: 'MCP Events',
		summary:
			'Let MCP clients such as ChatGPT subscribe to events your packages emit, so the agent wakes up when something happens.',
		docsSlug: 'mcp-events',
		stage: 'Draft MCP extension: webhook delivery only.',
	},
] as const satisfies ReadonlyArray<SelfServeExperiment>

export type SelfServeExperimentId = (typeof selfServeExperiments)[number]['id']

/**
 * `you`: the person turned it on or off themselves (a per-user override).
 * `kody`: an operator, org, or rollout decided; the person has not chosen.
 */
type SelfServeExperimentChoice = 'you' | 'kody'

/** One experiment as one person sees it. */
export type SelfServeExperimentState = {
	id: SelfServeExperimentId
	title: string
	summary: string
	stage: string
	docsPath: string
	enabled: boolean
	choice: SelfServeExperimentChoice
	/** Org section path suffix when the feature has its own page. */
	orgSection: string | null
}

export const selfServeExperimentIds = selfServeExperiments.map(
	(experiment) => experiment.id,
) as unknown as readonly [
	SelfServeExperimentId,
	...Array<SelfServeExperimentId>,
]

/**
 * Flags that target the experiments audience but are not self-serve, with
 * why. Every `experiments_opt_in` flag must be in `selfServeExperiments` or
 * here, so a new experiment flag has to decide.
 */
export const notSelfServeExperimentFlags: Partial<
	Record<FeatureFlagKey, string>
> = {
	'connection-profiles':
		'Operator-run dogfood of profile-bound connections; no user docs yet.',
	'repo-push-queue':
		'Infrastructure kill switch evaluated per repo, not a user-facing feature.',
}

export function getSelfServeExperimentForDoc(
	docsSlug: string,
): (typeof selfServeExperiments)[number] | null {
	return (
		selfServeExperiments.find(
			(experiment) => experiment.docsSlug === docsSlug,
		) ?? null
	)
}

/** Flag keys that target the experiments audience by default. */
export function experimentAudienceFlagKeys(): Array<FeatureFlagKey> {
	return featureFlagDefinitions
		.filter(
			(definition) =>
				'defaultAudience' in definition &&
				definition.defaultAudience === 'experiments_opt_in',
		)
		.map((definition) => definition.key)
}

/**
 * Error text when a request needs a self-serve experiment that is off. Names
 * every way to turn it on so a person or an agent can act on it.
 */
export function experimentOffMessage(id: SelfServeExperimentId) {
	const experiment = selfServeExperiments.find((entry) => entry.id === id)
	if (!experiment) throw new Error(`Unknown experiment: ${id}`)
	return `${experiment.title} is an experiment that is off for this account. Turn it on at /account/experiments, or ask your agent to call experimentSet with { "experiment": "${experiment.id}", "enabled": true }. Guide: /docs/${experiment.docsSlug}`
}
