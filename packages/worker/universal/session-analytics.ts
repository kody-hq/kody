/** An org's session analytics choice. Only `enabled` records anything. */
export const sessionAnalyticsStates = ['unset', 'enabled', 'declined'] as const
export type SessionAnalyticsState = (typeof sessionAnalyticsStates)[number]

export const sessionOutcomes = [
	'succeeded',
	'recovered',
	'stuck',
	'abandoned',
	'unknown',
] as const
export type SessionOutcome = (typeof sessionOutcomes)[number]

/** Closed error-kind enum. The raw error message is never copied. */
export const sessionStuckKinds = [
	'user_code',
	'credential_missing',
	'credential_denied',
	'validation',
	'not_found',
	'entitlement',
	'timeout',
	'platform',
	'other',
] as const
export type SessionStuckKind = (typeof sessionStuckKinds)[number]

const sessionSurfaces = ['mcp', 'cli', 'api'] as const
export type SessionSurface = (typeof sessionSurfaces)[number]

export const sessionInsightsScopes = ['mine', 'org'] as const
export type SessionInsightsScope = (typeof sessionInsightsScopes)[number]

/** Cross-org cells need this many sessions from this many orgs to be shown. */
export const sessionInsightsMinSessions = 10
export const sessionInsightsMinOrgs = 5

export const sessionStuckKindLabels: Record<SessionStuckKind, string> = {
	user_code: 'Error in the code it ran',
	credential_missing: 'Missing credential',
	credential_denied: 'Credential not allowed',
	validation: 'Invalid input',
	not_found: 'Not found',
	entitlement: 'Plan limit',
	timeout: 'Timed out',
	platform: 'Kody error',
	other: 'Other error',
}

export const sessionOutcomeLabels: Record<SessionOutcome, string> = {
	succeeded: 'Ended without errors',
	recovered: 'Recovered after errors',
	stuck: 'Ended stuck',
	abandoned: 'Stopped after one error',
	unknown: 'Too short to tell',
}

/** One insights row: a category, how it ended, and where it got stuck. */
export type SessionInsightsEntry = {
	categoryId: string
	categoryName: string
	outcome: SessionOutcome
	stuckKind: SessionStuckKind | null
	stuckTool: string | null
	sessions: number
	calls: number
	errors: number
}

type SessionInsightsSummary = {
	sessions: number
	linkedSessions: number
	endedWithoutErrors: number
	stuck: number
	recovered: number
	nudgedSessions: number
	calls: number
	errors: number
}

type SessionInsightsClientRow = {
	clientName: string
	sessions: number
	endedWithoutErrors: number
	stuck: number
}

export type SessionInsightsView = {
	windowDays: number
	summary: SessionInsightsSummary
	entries: Array<SessionInsightsEntry>
	clients: Array<SessionInsightsClientRow>
}

export type SessionAnalyticsSettingsView = {
	state: SessionAnalyticsState
	canChange: boolean
}

export const sessionAnalyticsAskTitle =
	'Help improve Kody with session analytics?'

/** The opt-in explanation, shown on the settings panel and the Waiting item. */
export function sessionAnalyticsAskParagraphs(orgName: string) {
	return [
		`If you turn this on for ${orgName}, Kody will count, for each agent session, a general category of work (for example "connect service"), whether it ended without errors, and where it got stuck. We use this to find and fix the places agents struggle, and a stuck agent may get one extra line of help on a repeated error.`,
		'We never store what your agents send: no code, queries, results, secrets, memory, or names of your packages. The short task description your agents already send for memory is read once by Kody’s AI provider (Cloudflare Workers AI) to pick the category and then discarded.',
		`You see the same insights we do, for your own data, and you can delete any entry. Kody staff and the publishers of public packages you use see only combined totals across at least ${sessionInsightsMinOrgs} organizations. If you turn this off later, everything stored for ${orgName} is deleted right away.`,
		`Everyone in ${orgName} can see this setting. An Owner or Admin can change it any time in Organization settings.`,
	]
}

export function sessionAnalyticsOffConfirmation(orgName: string) {
	return `Turning this off deletes everything session analytics stored for ${orgName} right away. This cannot be undone.`
}
