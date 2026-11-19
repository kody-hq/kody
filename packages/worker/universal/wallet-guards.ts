/**
 * Denial-of-wallet guards: very high call ceilings per org and per person
 * that normal use never reaches. They cap what a runaway loop or an abusive
 * caller can cost (Artifacts git operations, execute, publish and check
 * runs, RunLog reads) and are not plan features: every plan gets the same
 * numbers, and an admin raises one org with a limit override.
 *
 * Sized from 30 days of production usage (November 2026): each org limit is
 * at least 10x the busiest customer org and at least 5x our own automation
 * orgs. The per-person limit is half the org limit.
 */

export type WalletGuardWindow = 'minute' | 'five_minutes' | 'hour' | 'day'

export const walletGuardWindowMs: Record<WalletGuardWindow, number> = {
	minute: 60_000,
	five_minutes: 5 * 60_000,
	hour: 60 * 60_000,
	day: 24 * 60 * 60_000,
}

const walletGuardWindowLabels: Record<WalletGuardWindow, string> = {
	minute: 'minute',
	five_minutes: '5 minutes',
	hour: 'hour',
	day: 'day (UTC)',
}

/** Org-level ceilings. Spread into every plan table; overrides raise them. */
export const walletGuardPlanLimits = {
	maxExecuteCallsPerDay: 120_000,
	maxGitOperationsPer5Minutes: 5_000,
	maxGitOperationsPerDay: 40_000,
	maxPublishesPerHour: 1_200,
	maxPublishesPerDay: 2_400,
	maxPackageChecksPerHour: 1_200,
	maxPackageChecksPerDay: 2_400,
	maxRepoChangesPerHour: 1_200,
	maxRepoChangesPerDay: 2_400,
	maxRunReadsPerMinute: 10_000,
	maxRunReadsPerDay: 60_000,
}

export type WalletGuardPlanLimits = {
	[Field in keyof typeof walletGuardPlanLimits]: number
}

export type WalletGuardLimitField = keyof WalletGuardPlanLimits

export const walletGuardLimitKeys = [
	'execute_calls_per_day',
	'git_operations_per_5_minutes',
	'git_operations_per_day',
	'publishes_per_hour',
	'publishes_per_day',
	'package_checks_per_hour',
	'package_checks_per_day',
	'repo_changes_per_hour',
	'repo_changes_per_day',
	'run_reads_per_minute',
	'run_reads_per_day',
] as const

export type WalletGuardLimitKey = (typeof walletGuardLimitKeys)[number]

export const walletGuardLimitFields: Record<
	WalletGuardLimitKey,
	WalletGuardLimitField
> = {
	execute_calls_per_day: 'maxExecuteCallsPerDay',
	git_operations_per_5_minutes: 'maxGitOperationsPer5Minutes',
	git_operations_per_day: 'maxGitOperationsPerDay',
	publishes_per_hour: 'maxPublishesPerHour',
	publishes_per_day: 'maxPublishesPerDay',
	package_checks_per_hour: 'maxPackageChecksPerHour',
	package_checks_per_day: 'maxPackageChecksPerDay',
	repo_changes_per_hour: 'maxRepoChangesPerHour',
	repo_changes_per_day: 'maxRepoChangesPerDay',
	run_reads_per_minute: 'maxRunReadsPerMinute',
	run_reads_per_day: 'maxRunReadsPerDay',
}

export const walletGuardLimitKeyLabels: Record<WalletGuardLimitKey, string> = {
	execute_calls_per_day: 'Execute calls per day (safety ceiling)',
	git_operations_per_5_minutes: 'Git operations per 5 minutes (safety ceiling)',
	git_operations_per_day: 'Git operations per day (safety ceiling)',
	publishes_per_hour: 'Publishes per hour (safety ceiling)',
	publishes_per_day: 'Publishes per day (safety ceiling)',
	package_checks_per_hour: 'Checks per hour (safety ceiling)',
	package_checks_per_day: 'Checks per day (safety ceiling)',
	repo_changes_per_hour: 'Repo changes per hour (safety ceiling)',
	repo_changes_per_day: 'Repo changes per day (safety ceiling)',
	run_reads_per_minute: 'Run reads per minute (safety ceiling)',
	run_reads_per_day: 'Run reads per day (safety ceiling)',
}

export function isWalletGuardLimitKey(
	value: string,
): value is WalletGuardLimitKey {
	return (walletGuardLimitKeys as ReadonlyArray<string>).includes(value)
}

export const walletGuardNames = [
	'execute',
	'git',
	'publish',
	'check',
	'repo_change',
	'run_read',
] as const

export type WalletGuardName = (typeof walletGuardNames)[number]

export type WalletGuardDefinition = {
	/** What is counted, as the error message names it. */
	label: string
	limits: ReadonlyArray<{ key: WalletGuardLimitKey; window: WalletGuardWindow }>
}

export const walletGuards: Record<WalletGuardName, WalletGuardDefinition> = {
	// The per-minute burst is the existing `execute_calls_per_minute` brake.
	execute: {
		label: 'execute calls',
		limits: [{ key: 'execute_calls_per_day', window: 'day' }],
	},
	// Git remote mints and smart-HTTP git requests, each of which costs
	// Artifacts operations.
	git: {
		label: 'git operations',
		limits: [
			{ key: 'git_operations_per_5_minutes', window: 'five_minutes' },
			{ key: 'git_operations_per_day', window: 'day' },
		],
	},
	publish: {
		label: 'publishes',
		limits: [
			{ key: 'publishes_per_hour', window: 'hour' },
			{ key: 'publishes_per_day', window: 'day' },
		],
	},
	check: {
		label: 'checks',
		limits: [
			{ key: 'package_checks_per_hour', window: 'hour' },
			{ key: 'package_checks_per_day', window: 'day' },
		],
	},
	// Repo and package create, fork, delete, and repo session opens.
	repo_change: {
		label: 'repo changes',
		limits: [
			{ key: 'repo_changes_per_hour', window: 'hour' },
			{ key: 'repo_changes_per_day', window: 'day' },
		],
	},
	run_read: {
		label: 'run reads',
		limits: [
			{ key: 'run_reads_per_minute', window: 'minute' },
			{ key: 'run_reads_per_day', window: 'day' },
		],
	},
}

export type WalletGuardScope = 'user' | 'org'

/** One person may use half of what their org may. */
export function walletGuardUserLimit(orgLimit: number): number {
	return Math.ceil(orgLimit / 2)
}

export const walletGuardSupportEmail = 'support@kody.codes'

export const walletGuardLimitErrorCode = 'wallet_guard_limit' as const

export type WalletGuardLimitErrorDetails = {
	code: typeof walletGuardLimitErrorCode
	guard: WalletGuardName
	/** Which limit was hit; the admin override key for the org scope. */
	limitKey: WalletGuardLimitKey
	scope: WalletGuardScope
	window: WalletGuardWindow
	windowSeconds: number
	limit: number
	retryAfterSeconds: number
	support: typeof walletGuardSupportEmail
}

export function buildWalletGuardLimitMessage(
	details: Omit<WalletGuardLimitErrorDetails, 'code' | 'support'>,
): string {
	const who = details.scope === 'org' ? 'organization' : 'person'
	return `Rate limit reached (${details.limitKey}, per ${who}): ${details.limit.toLocaleString('en-US')} ${walletGuards[details.guard].label} per ${walletGuardWindowLabels[details.window]} per ${who}. Retry in ${details.retryAfterSeconds}s. This is a safety ceiling that normal use does not reach, so check for a loop. To get it raised, email ${walletGuardSupportEmail}.`
}
