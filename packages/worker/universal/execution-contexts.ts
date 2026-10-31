/**
 * Website contract for execution contexts: the list, detail and chain shapes
 * the API returns (docs/design execution-contexts-ui-plan section 12), plus the
 * pure chain helpers and labels the page uses. Kody cloud is always the last
 * chain entry; contexts are ordered above it.
 */

export const maxChainContexts = 3
const unutilizedNamedMax = 3
const revokedVisibleDays = 30

const executionContextUnusableReasons = [
	'not_attached',
	'not_granted',
	'revoked',
	'not_opted_in',
	'credential_scope',
] as const
export type ExecutionContextUnusableReason =
	(typeof executionContextUnusableReasons)[number]

type ExecutionContextStatus = 'online' | 'offline' | 'revoked'
export type ExecutionContextDisplayStatus =
	| 'online'
	| 'busy'
	| 'offline'
	| 'revoked'

type ExecutionContextPermission =
	| 'read'
	| 'execute'
	| 'write'
	| 'delete'
	| 'manage_access'
	| 'command'

export type ExecutionContextPreset = 'use' | 'contribute' | 'manage'
export type ExecutionContextSharingLevel = 'only_me' | 'people' | 'team' | 'org'
export type ExecutionContextEgressMode =
	| 'public'
	| 'public-and-lan'
	| 'allowlist'
	| 'none'

type ExecutionContextGrantSubject =
	| { kind: 'user'; handle: string; outside?: boolean }
	| { kind: 'team'; slug: string; name?: string; orgSlug?: string }

export type ExecutionContextShareGrant = {
	grantId: string
	orgSlug?: string
	subject: ExecutionContextGrantSubject
	preset: ExecutionContextPreset
	/** Explicit execution_context:command on top of the preset (ADR 0093). */
	commands?: boolean
}

export type ExecutionContextSharing = {
	level: ExecutionContextSharingLevel
	grants: Array<ExecutionContextShareGrant>
	attachedOrgs: Array<{ id?: string; slug: string; allMembers?: boolean }>
	allMembers: boolean
}

export type ExecutionContextGrantSummary = {
	fs: number
	fsMode?: 'read' | 'write'
	egress: { mode: ExecutionContextEgressMode; hosts?: number }
	runtime: 'all' | 'none' | { mode: 'allowlist'; count: number }
	timeoutMs: number
	/** Host commands (ADR 0093): on only after the machine opted in locally. */
	commands?: boolean
}

type ExecutionContextChainUsage = {
	inMyChain: boolean
	chainCount: number
}

export type ExecutionContextListItem = {
	id: string
	name: string
	ownerOrg: { id: string; slug: string }
	operator: { handle: string }
	isOperator: boolean
	myPermissions: Array<ExecutionContextPermission>
	sharing?: ExecutionContextSharing
	registeredBy?: { handle: string }
	status: ExecutionContextStatus
	acceptingRuns: boolean
	lastSeenAt: string | null
	revokedAt: string | null
	client: {
		name: string
		version: string
		/** Newest published @kodycodes/cli, when Kody could look it up. */
		latestVersion?: string | null
		outdated?: boolean
	} | null
	capabilities: {
		os?: string
		maxConcurrent?: number
		features?: Array<string>
		/** Background service manager, or null when run in a terminal. */
		service?: 'systemd' | 'launchd' | null
	} | null
	grantSummary: ExecutionContextGrantSummary
	optedIn: boolean
	usable: boolean
	unusableReason?: ExecutionContextUnusableReason
	canOptIn?: boolean
	canAddShares?: boolean
	chainUsage: ExecutionContextChainUsage
}

export type ExecutionContextUnutilized = {
	count: number
	contexts?: Array<{
		id: string
		name: string
		operator?: { handle: string } | string
		ownerKind?: string
		needsOptIn: boolean
	}>
	note: string
}

export type ExecutionChainEntry =
	| {
			kind: 'context'
			id: string
			usable: boolean
			unusableReason?: ExecutionContextUnusableReason
	  }
	| { kind: 'cloud' }

export type ExecutionChainEntryInput =
	| { kind: 'context'; id: string }
	| { kind: 'cloud' }

export type ExecutionChain = {
	entries: Array<ExecutionChainEntry>
	strict: boolean
	updatedAt: string | null
	updatedBy: { kind: 'user' | 'agent'; label: string } | null
}

export type ExecutionContextRunOutcome =
	| 'succeeded'
	| 'failed'
	| 'cancelled'
	| 'lost'
	| 'rejected'
	| 'aborted'
	| 'offline'
	| 'busy'
	| 'timeout'

export type ExecutionContextRun = {
	runId: string
	requester: { userId?: string; handle: string }
	runOrgId?: string
	dispatchedAt: string
	startedAt?: string | null
	endedAt?: string | null
	durationMs?: number | null
	/** Null while the run is still in progress. */
	outcome: ExecutionContextRunOutcome | null
	cancelReason?: string | null
	/** Why a run that started on the context failed, was lost, or was cancelled. */
	failureReason?: string | null
	/** Short error text for that failure. */
	errorSummary?: string | null
	fallback?: { position: number; ranOn?: string } | null
}

export type ExecutionContextRunPage = {
	runs: Array<ExecutionContextRun>
	nextCursor: string | null
	/** Managers see every requester; everyone else sees only their own rows. */
	scope: 'all' | 'own'
}

type ExecutionContextAuditEvent = {
	id: string
	action: string
	actor: { kind?: string; label: string } | null
	at: string
	detail?: string | null
}

export type ExecutionContextAuditPage = {
	events: Array<ExecutionContextAuditEvent>
	nextCursor: string | null
}

/** Numeric x.y.z compare; a prerelease sorts before its stable release. Build tags are ignored. */
export function isOlderCliVersion(version: string, latest: string) {
	const parts = (value: string) =>
		value
			.split(/[-+]/)[0]!
			.split('.')
			.map((part) => Number.parseInt(part, 10) || 0)
	const a = parts(version)
	const b = parts(latest)
	for (let index = 0; index < 3; index++) {
		const left = a[index] ?? 0
		const right = b[index] ?? 0
		if (left !== right) return left < right
	}
	const prerelease = (value: string) => value.split('+')[0]!.includes('-')
	return prerelease(version) && !prerelease(latest)
}

export function daemonRunsAsLabel(
	service: 'systemd' | 'launchd' | null | undefined,
	status: ExecutionContextStatus,
) {
	if (service === 'systemd') return 'Background service (systemd)'
	if (service === 'launchd') return 'Background service (launchd)'
	if (status !== 'online') return 'Not running'
	return 'Terminal (not a background service)'
}

export type ExecutionContextsPageData =
	| { enabled: false; orgSlug: string }
	| {
			enabled: true
			orgSlug: string
			personalOrg: boolean
			teams: Array<{ slug: string; name: string; orgSlug: string }>
			attachableOrgs: Array<{ slug: string; name?: string }>
			contexts: Array<ExecutionContextListItem>
			chain: ExecutionChain
			unutilized: ExecutionContextUnutilized | null
			selected: ExecutionContextListItem | null
			selectedMissing: boolean
	  }

export function isUnusableReason(
	value: unknown,
): value is ExecutionContextUnusableReason {
	return (
		typeof value === 'string' &&
		(executionContextUnusableReasons as ReadonlyArray<string>).includes(value)
	)
}

/** Strip a GET chain to what a PUT accepts. */
export function chainEntryInputs(
	entries: ReadonlyArray<ExecutionChainEntry | ExecutionChainEntryInput>,
): Array<ExecutionChainEntryInput> {
	return entries.map((entry) =>
		entry.kind === 'cloud'
			? { kind: 'cloud' }
			: { kind: 'context', id: entry.id },
	)
}

export function chainHasCloud(
	entries: ReadonlyArray<{ kind: string }>,
): boolean {
	return entries.some((entry) => entry.kind === 'cloud')
}

function chainContextIds(
	entries: ReadonlyArray<ExecutionChainEntry | ExecutionChainEntryInput>,
): Array<string> {
	return entries.flatMap((entry) =>
		entry.kind === 'context' ? [entry.id] : [],
	)
}

/** Skipped (unusable) entries still count toward the cap. */
export function chainIsFull(
	entries: ReadonlyArray<ExecutionChainEntry | ExecutionChainEntryInput>,
): boolean {
	return chainContextIds(entries).length >= maxChainContexts
}

/**
 * Contexts in their stored order, then Kody cloud when present. Cloud can only
 * be last, so any stored order is normalized to that.
 */
export function normalizeChain<T extends { kind: string }>(
	entries: ReadonlyArray<T>,
): Array<T> {
	const contexts = entries.filter((entry) => entry.kind !== 'cloud')
	const cloud = entries.find((entry) => entry.kind === 'cloud')
	return cloud ? [...contexts, cloud] : contexts
}

/** Move a context `delta` places among the contexts. Cloud stays last. */
export function moveChainContext<T extends { kind: string; id?: string }>(
	entries: ReadonlyArray<T>,
	contextId: string,
	delta: number,
): Array<T> {
	const normalized = normalizeChain(entries)
	const contexts = normalized.filter((entry) => entry.kind === 'context')
	const from = contexts.findIndex((entry) => entry.id === contextId)
	if (from < 0) return normalized
	const to = Math.max(0, Math.min(contexts.length - 1, from + delta))
	if (to === from) return normalized
	const next = contexts.slice()
	const [moved] = next.splice(from, 1)
	if (moved) next.splice(to, 0, moved)
	return chainHasCloud(normalized)
		? [...next, ...normalized.filter((entry) => entry.kind === 'cloud')]
		: next
}

/** Reorder contexts to match `orderedIds` (ids not listed keep their place at the end). */
export function reorderChainContexts<T extends { kind: string; id?: string }>(
	entries: ReadonlyArray<T>,
	orderedIds: ReadonlyArray<string>,
): Array<T> {
	const normalized = normalizeChain(entries)
	const contexts = normalized.filter((entry) => entry.kind === 'context')
	const byId = new Map(contexts.map((entry) => [entry.id, entry]))
	const ordered = orderedIds.flatMap((id) => {
		const entry = byId.get(id)
		return entry ? [entry] : []
	})
	const rest = contexts.filter((entry) => !orderedIds.includes(entry.id ?? ''))
	return [
		...ordered,
		...rest,
		...normalized.filter((entry) => entry.kind === 'cloud'),
	]
}

export function removeChainContext<T extends { kind: string; id?: string }>(
	entries: ReadonlyArray<T>,
	contextId: string,
): Array<T> {
	return normalizeChain(
		entries.filter(
			(entry) => !(entry.kind === 'context' && entry.id === contextId),
		),
	)
}

/** Insert a context as the last context, just before Kody cloud. */
export function insertBeforeCloud(
	entries: ReadonlyArray<ExecutionChainEntryInput>,
	contextId: string,
): Array<ExecutionChainEntryInput> {
	const normalized = normalizeChain(entries)
	if (chainContextIds(normalized).includes(contextId)) return normalized
	const contexts = normalized.filter((entry) => entry.kind === 'context')
	return [
		...contexts,
		{ kind: 'context', id: contextId },
		...normalized.filter((entry) => entry.kind === 'cloud'),
	]
}

export function withoutCloud<T extends { kind: string }>(
	entries: ReadonlyArray<T>,
): Array<T> {
	return entries.filter((entry) => entry.kind !== 'cloud')
}

export function withCloud(
	entries: ReadonlyArray<ExecutionChainEntryInput>,
): Array<ExecutionChainEntryInput> {
	return [...withoutCloud(normalizeChain(entries)), { kind: 'cloud' }]
}

export function chainPosition(
	entries: ReadonlyArray<ExecutionChainEntry | ExecutionChainEntryInput>,
	contextId: string,
): number | null {
	const index = chainContextIds(normalizeChain(entries)).indexOf(contextId)
	return index < 0 ? null : index + 1
}

export function ordinal(position: number): string {
	const mod100 = position % 100
	if (mod100 >= 11 && mod100 <= 13) return `${position}th`
	switch (position % 10) {
		case 1:
			return `${position}st`
		case 2:
			return `${position}nd`
		case 3:
			return `${position}rd`
		default:
			return `${position}th`
	}
}

export function contextDisplayStatus(
	context: Pick<ExecutionContextListItem, 'status' | 'acceptingRuns'>,
): ExecutionContextDisplayStatus {
	if (context.status === 'revoked') return 'revoked'
	if (context.status === 'offline') return 'offline'
	return context.acceptingRuns ? 'online' : 'busy'
}

export function displayStatusLabel(status: ExecutionContextDisplayStatus) {
	switch (status) {
		case 'online':
			return 'Online'
		case 'busy':
			return 'Busy'
		case 'offline':
			return 'Offline'
		case 'revoked':
			return 'Revoked'
		default: {
			const exhaustive: never = status
			return exhaustive
		}
	}
}

export type ChainWarning =
	| 'none'
	| 'cloud-only'
	| 'strict-no-usable'
	| 'strict-none-accepting'

/** Which banner the chain panel shows for the resolved chain. */
export function chainWarning(input: {
	chain: Pick<ExecutionChain, 'entries'>
	contextsById: ReadonlyMap<
		string,
		Pick<ExecutionContextListItem, 'status' | 'acceptingRuns'>
	>
}): ChainWarning {
	const entries = normalizeChain(input.chain.entries)
	const usable = entries.flatMap((entry) =>
		entry.kind === 'context' && entry.usable ? [entry.id] : [],
	)
	if (chainHasCloud(entries)) {
		return usable.length === 0 ? 'cloud-only' : 'none'
	}
	if (usable.length === 0) return 'strict-no-usable'
	const accepting = usable.some((id) => {
		const context = input.contextsById.get(id)
		return context ? contextDisplayStatus(context) === 'online' : false
	})
	return accepting ? 'none' : 'strict-none-accepting'
}

/** The skipped label a stored but unusable chain row shows. */
export function skippedLabel(
	reason: ExecutionContextUnusableReason | undefined,
) {
	switch (reason) {
		case 'revoked':
			return 'Revoked, skipped'
		case 'not_attached':
			return 'Not usable here, skipped'
		case 'not_opted_in':
			return 'Not opted in, skipped'
		case 'credential_scope':
			return 'Login too old, skipped'
		case 'not_granted':
		default:
			return 'Access lost, skipped'
	}
}

export const loginPredatesPermissionsMessage =
	'Your Kody login predates execution context permissions. Run `kody login` again, then try again.'

export function unusableReasonCopy(input: {
	reason: ExecutionContextUnusableReason
	name: string
	operator: string
	orgSlug: string
}) {
	switch (input.reason) {
		case 'not_attached':
			return `Not usable in @${input.orgSlug}: it is not shared with this organization. Ask @${input.operator} to attach it to @${input.orgSlug}.`
		case 'not_granted':
			return `Not shared with you in @${input.orgSlug}. Ask @${input.operator} or someone who manages its sharing.`
		case 'revoked':
			return 'This context was revoked. Runs skip it.'
		case 'not_opted_in':
			return 'You are not opted in, so your runs will not use it.'
		case 'credential_scope':
			return loginPredatesPermissionsMessage
		default: {
			const exhaustive: never = input.reason
			return exhaustive
		}
	}
}

function egressLabel(mode: ExecutionContextEgressMode) {
	switch (mode) {
		case 'public':
			return 'public'
		case 'public-and-lan':
			return 'public and LAN'
		case 'allowlist':
			return 'allowlist'
		case 'none':
			return 'none'
		default: {
			const exhaustive: never = mode
			return exhaustive
		}
	}
}

function pluralize(count: number, one: string, many = `${one}s`) {
	return `${count} ${count === 1 ? one : many}`
}

export function runtimeLabel(runtime: ExecutionContextGrantSummary['runtime']) {
	if (runtime === 'all') return 'all'
	if (runtime === 'none') return 'none'
	return runtime.count === 0 ? 'none' : `${runtime.count} allowed`
}

function timeoutLabel(timeoutMs: number) {
	return `${Math.round(timeoutMs / 1000)} s`
}

/** Compact grants cell for the table. */
export function grantSummaryCell(grant: ExecutionContextGrantSummary) {
	const egress =
		grant.egress.mode === 'none'
			? 'no egress'
			: `${egressLabel(grant.egress.mode)} egress`
	return [
		pluralize(grant.fs, 'path'),
		egress,
		`Kody APIs: ${runtimeLabel(grant.runtime)}`,
		timeoutLabel(grant.timeoutMs),
	].join(' · ')
}

/** Full grants line for the detail view. */
export function grantSummaryDetail(grant: ExecutionContextGrantSummary) {
	return [
		`Filesystem: ${pluralize(grant.fs, 'path')}`,
		`Egress: ${egressLabel(grant.egress.mode)}`,
		`Kody APIs: ${runtimeLabel(grant.runtime)}`,
		`Timeout: ${timeoutLabel(grant.timeoutMs)}`,
		`Commands: ${grant.commands ? 'on' : 'off'}`,
	].join(' · ')
}

/** "Only me" / "{n} people" / "Team {t}" / "Everyone in @{org}", joined. */
export function sharingSummary(
	sharing: ExecutionContextSharing | undefined,
	ownerOrgSlug: string,
): string | null {
	if (!sharing) return null
	const people = sharing.grants.filter((grant) => grant.subject.kind === 'user')
	const teams = sharing.grants.flatMap((grant) =>
		grant.subject.kind === 'team'
			? [grant.subject.name ?? grant.subject.slug]
			: [],
	)
	const parts: Array<string> = []
	if (people.length > 0)
		parts.push(pluralize(people.length, 'person', 'people'))
	for (const team of teams) parts.push(`Team ${team}`)
	if (sharing.allMembers) parts.push(`Everyone in @${ownerOrgSlug}`)
	for (const org of sharing.attachedOrgs) {
		if (org.allMembers) parts.push(`Everyone in @${org.slug}`)
	}
	return parts.length > 0 ? parts.join(' + ') : 'Only me'
}

export function canOptIntoContext(
	context: Pick<
		ExecutionContextListItem,
		'isOperator' | 'optedIn' | 'canOptIn' | 'status' | 'myPermissions'
	>,
) {
	if (context.isOperator || context.optedIn || context.status === 'revoked') {
		return false
	}
	return context.canOptIn ?? context.myPermissions.includes('execute')
}

/** Contexts the viewer could add to their chain right now. */
export function addableContexts(
	contexts: ReadonlyArray<ExecutionContextListItem>,
	chain: Pick<ExecutionChain, 'entries'>,
) {
	const inChain = new Set(chainContextIds(chain.entries))
	return contexts.filter(
		(context) => context.usable && !inChain.has(context.id),
	)
}

/** Revoked rows stay listed for 30 days after revocation. */
export function visibleContexts(
	contexts: ReadonlyArray<ExecutionContextListItem>,
	now: number,
) {
	const cutoff = now - revokedVisibleDays * 24 * 60 * 60 * 1000
	return contexts.filter(
		(context) => !context.revokedAt || Date.parse(context.revokedAt) >= cutoff,
	)
}

/** Local `unutilized` fallback when the API response omits it. */
export function unutilizedNote(
	unutilized: ExecutionContextUnutilized | null | undefined,
): string | null {
	if (!unutilized || unutilized.count === 0) return null
	if (!unutilized.contexts || unutilized.count > unutilizedNamedMax) {
		return `There are ${unutilized.count} unutilized execution context registrations.`
	}
	const names = unutilized.contexts.map((context) =>
		context.needsOptIn ? `${context.name} (needs opt-in)` : context.name,
	)
	return `Not in your chain yet: ${names.join(', ')}.`
}

export type ContextAccessCell =
	| { kind: 'yours' }
	| { kind: 'in-chain'; position: number }
	| { kind: 'opted-in' }
	| { kind: 'opt-in' }
	| { kind: 'not-usable' }
	| { kind: 'unavailable' }

export function contextAccessCell(
	context: ExecutionContextListItem,
	chain: Pick<ExecutionChain, 'entries'>,
): ContextAccessCell {
	const position = chainPosition(chain.entries, context.id)
	if (position !== null) return { kind: 'in-chain', position }
	if (context.status === 'revoked') return { kind: 'unavailable' }
	if (context.isOperator) return { kind: 'yours' }
	if (
		context.unusableReason === 'not_attached' ||
		context.unusableReason === 'not_granted'
	) {
		return { kind: 'not-usable' }
	}
	if (context.optedIn) return { kind: 'opted-in' }
	if (canOptIntoContext(context)) return { kind: 'opt-in' }
	return { kind: 'unavailable' }
}

export const runOutcomeLabels: Record<ExecutionContextRunOutcome, string> = {
	succeeded: 'Succeeded',
	failed: 'Failed',
	cancelled: 'Cancelled',
	lost: 'Lost',
	rejected: 'Rejected',
	aborted: 'Aborted',
	offline: 'Offline',
	busy: 'Busy',
	timeout: 'Timed out',
}

/** "Ran here" / "Skipped (busy), ran on Kody cloud" / "Skipped (offline), ran on buildbox". */
export function runFallbackLabel(input: {
	run: ExecutionContextRun
	contextId: string
	nameForId: (id: string) => string | undefined
}) {
	const ranOn = input.run.fallback?.ranOn
	if (!ranOn || ranOn === input.contextId) return 'Ran here'
	const target =
		ranOn === 'cloud' ? 'Kody cloud' : (input.nameForId(ranOn) ?? ranOn)
	const why =
		input.run.outcome === 'busy' ||
		input.run.outcome === 'offline' ||
		input.run.outcome === 'timeout' ||
		input.run.outcome === 'rejected'
			? runOutcomeLabels[input.run.outcome].toLowerCase()
			: 'skipped'
	return `Skipped (${why}), ran on ${target}`
}

export function durationLabel(durationMs: number | null | undefined) {
	if (durationMs === null || durationMs === undefined) return '-'
	if (durationMs < 1000) return `${durationMs} ms`
	const seconds = durationMs / 1000
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
	const minutes = Math.floor(seconds / 60)
	return `${minutes} min ${Math.round(seconds % 60)} s`
}

const executionContextAuditLabels: Record<string, string> = {
	'execution_context.registered': 'Registered',
	'execution_context.grant_updated': 'Access changed',
	'execution_context.key_rotated': 'Key rotated',
	'execution_context.revoked': 'Revoked',
	'execution_context.opted_in': 'Opted in',
	'execution_context.opted_out': 'Opted out',
	'execution_context.chain_added': 'Added to a chain',
	'execution_context.chain_removed': 'Removed from a chain',
	'execution_context.run_dispatched': 'Run dispatched',
	'execution_context.run_finished': 'Run finished',
	registered: 'Registered',
	updated: 'Access changed',
	grant_updated: 'Access changed',
	key_rotated: 'Key rotated',
	revoked: 'Revoked',
	opt_in: 'Opted in',
	opt_out: 'Opted out',
	share_added: 'Shared',
	share_removed: 'Stopped sharing',
	all_members_on: 'Shared with everyone in the org',
	all_members_off: 'Stopped sharing with everyone in the org',
	attached: 'Attached to an org',
	detached: 'Detached from an org',
	chain_added: 'Added to a chain',
	chain_removed: 'Removed from a chain',
	commands_enabled: 'Commands turned on (on the machine)',
	commands_disabled: 'Commands turned off',
	command_started: 'Command started',
	command_finished: 'Command finished',
	run_cancelled: 'Run cancelled',
}

/** `$ npm test in /repo, exit 0` for host command audit rows (ADR 0093). */
export function commandAuditSummary(detail: string | null | undefined) {
	if (!detail) return null
	let parsed: Record<string, unknown>
	try {
		parsed = JSON.parse(detail) as Record<string, unknown>
	} catch {
		return null
	}
	if (typeof parsed.command !== 'string') return null
	const parts = [`$ ${parsed.command}`]
	if (typeof parsed.cwd === 'string') parts.push(`in ${parsed.cwd}`)
	if (parsed.background === true) parts.push('(background)')
	if (typeof parsed.exitCode === 'number') parts.push(`exit ${parsed.exitCode}`)
	else if (typeof parsed.reason === 'string' && parsed.reason !== 'exited')
		parts.push(parsed.reason.replaceAll('_', ' '))
	return parts.join(' ')
}

export function auditEventLabel(action: string) {
	return executionContextAuditLabels[action] ?? action
}
