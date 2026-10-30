import { stripCredentialPlacementRefusalTag } from '#worker/credentials/placement-refusal.ts'
import { type SecretScope } from './types.ts'

const hostApprovalRequiredRegex =
	/^Secret "([^"]+)" is not allowed for host "([^"]+)"/
const packageAccessRequiredRegex =
	/^Secret "([^"]+)" is not allowed for package "([^"]+)"/
const hostBatchDeniedPrefix = 'Secrets require host approval:'
const packageBatchDeniedPrefix = 'Secrets require package approval:'
const missingSecretRegex = /^Secret "([^"]+)" was not found\.$/
const secretScopeUnavailableRegex =
	/^Secret "([^"]+)" exists in (session|package|user) scope(?: for package( id)? "([^"]+)")?/

export const fetchSecretAuthRequiredMessage =
	'Network requests that use secret placeholders require an authenticated user.'

const secretAuthRequiredMessages = new Set([fetchSecretAuthRequiredMessage])

export function createMissingSecretMessage(secretName: string) {
	return `Secret "${secretName}" was not found.`
}

export type SecretScopeMissingPackageContext = {
	kind: 'missing_package_context'
	/** Human label for the job/app/webhook runtime that lost package context. */
	runtimeLabel: string
	/** Package (or job context) last-saved timestamp when cheaply known. */
	contextSavedAt: string | null
}

export type SecretScopeUnavailableMatch = {
	secretName: string
	scope: SecretScope
	packageId: string | null
	packageName: string | null
	sessionId: string | null
	editorUrl: string | null
	/**
	 * When set, this package-scoped secret belongs to the same package as the
	 * current storage bucket, but the runtime has no usable packageId binding.
	 */
	missingPackageContext?: SecretScopeMissingPackageContext | null
}

function describeSecretScopeLocation(match: SecretScopeUnavailableMatch) {
	switch (match.scope) {
		case 'package':
			if (match.packageName) {
				return `package scope for package "${match.packageName}"`
			}
			if (match.packageId) {
				return `package scope for package id "${match.packageId}"`
			}
			return 'package scope'
		case 'session':
			return 'session scope'
		case 'user':
			return 'user scope'
		default: {
			const _exhaustive: never = match.scope
			return _exhaustive
		}
	}
}

function describeMissingPackageContextGuidance(
	issue: SecretScopeMissingPackageContext,
) {
	const savedSuffix = issue.contextSavedAt
		? ` (package context last saved ${issue.contextSavedAt})`
		: ''
	return (
		` This runtime is ${issue.runtimeLabel}, which belongs to that package, but its package context is missing.` +
		` Republish the package so this runtime gets a fresh package context${savedSuffix}.` +
		` Do not widen the secret's scope to work around a missing package context.`
	)
}

function describeDifferentPackageRuntimeGuidance() {
	return (
		" Prefer calling through an export of the owning package so the package-scoped secret is visible in that package's runtime." +
		" Changing the secret's scope is an explicit, owner-reviewed choice only — ask the account owner before doing that."
	)
}

export function createSecretScopeUnavailableMessage(
	matches: Array<SecretScopeUnavailableMatch>,
) {
	if (matches.length === 0) {
		throw new Error('At least one secret scope match is required.')
	}
	// When the same name exists in several packages, lead with the match whose
	// storage bucket owns this runtime so location + missing-context guidance
	// describe the same package (not an earlier sorted sibling).
	const missingContextMatch =
		matches.find((match) => match.missingPackageContext) ?? null
	const orderedMatches = missingContextMatch
		? [
				missingContextMatch,
				...matches.filter((match) => match !== missingContextMatch),
			]
		: matches
	const [first, ...rest] = orderedMatches
	if (!first) {
		throw new Error('At least one secret scope match is required.')
	}
	const extra =
		rest.length === 0
			? ''
			: ` It also exists in ${rest.map(describeSecretScopeLocation).join(', ')}.`
	const missingPackageContext = first.missingPackageContext ?? null
	if (missingPackageContext) {
		return `Secret "${first.secretName}" exists in ${describeSecretScopeLocation(first)} and is not visible from this runtime.${extra}${describeMissingPackageContextGuidance(missingPackageContext)}`
	}
	const hasPackageMatch = matches.some((match) => match.scope === 'package')
	const guidance = hasPackageMatch
		? describeDifferentPackageRuntimeGuidance()
		: " Prefer retrying from a runtime that can see this scope. Changing the secret's scope is an explicit, owner-reviewed choice only — ask the account owner before doing that."
	const editorUrl = matches.find((match) => match.editorUrl)?.editorUrl ?? null
	const editorSuffix = editorUrl ? ` Editor link: ${editorUrl}` : ''
	return `Secret "${first.secretName}" exists in ${describeSecretScopeLocation(first)} and is not visible from this runtime.${extra}${guidance}${editorSuffix}`
}

/** A resolved secret is not approved for the host it is about to be sent to. */
export class SecretHostNotApprovedError extends Error {
	readonly secretName: string
	readonly host: string
	readonly scope: SecretScope

	constructor(input: { secretName: string; host: string; scope: SecretScope }) {
		super(
			`Secret "${input.secretName}" is not allowed for host "${input.host}".`,
		)
		this.name = 'SecretHostNotApprovedError'
		this.secretName = input.secretName
		this.host = input.host
		this.scope = input.scope
	}
}

export type HostApprovalEntry = {
	secretName: string
	host: string
	approvalUrl: string
}

export type PackageApprovalEntry = {
	secretName: string
	packageId: string
	kodyId: string | null
	packageName: string | null
	approvalUrl: string
}

export function createHostSecretAccessDeniedBatchMessage(
	entries: Array<HostApprovalEntry>,
	options: { bulkApprovalUrl?: string | null } = {},
) {
	const bulkApprovalUrl = options.bulkApprovalUrl?.trim() || null
	const payload = JSON.stringify({
		entries,
		...(bulkApprovalUrl ? { bulkApprovalUrl } : {}),
	})
	return `${hostBatchDeniedPrefix} ${payload}`
}

export function createPackageSecretAccessDeniedMessage(input: {
	secretName: string
	packageName: string
	approvalUrl?: string | null
	/**
	 * True when the credential has a non-empty allowed-packages list that
	 * leaves this package out. Applies to self-authored and adopted packages
	 * too (issue #4129).
	 */
	notOnAllowedList?: boolean
}) {
	const approvalSuffix = input.approvalUrl
		? ` Approval link: ${input.approvalUrl}`
		: ''
	if (input.notOnAllowedList) {
		const where = input.approvalUrl
			? "on the secret's page (see the approval link)"
			: "on the secret's page in the account secrets UI"
		return `Secret "${input.secretName}" is not allowed for package "${input.packageName}": the credential's allowed-packages list does not include this package, and Kody enforces that list for every package, including ones you authored or adopted. The account owner can add "${input.packageName}" to the list ${where}, or move this credential use into a package that is already on the list. Ask the user before approving, then retry.${approvalSuffix}`
	}
	return `Secret "${input.secretName}" is not allowed for package "${input.packageName}". If this package should be able to use the secret, ask the user whether to approve that package in the account secrets UI, then retry after they approve that policy change.${approvalSuffix}`
}

export function createSecretPackageGrantRequiresWebsiteMessage(input: {
	approvalUrl: string
}) {
	return `Agents cannot add packages to a user secret's allowed_packages. Only the account owner can grant access on the website. Send the user this approval link and wait: ${input.approvalUrl}`
}

export function createSecretPackageGrantAlreadyPresentMessage(input: {
	packageName: string
}) {
	return `Package "${input.packageName}" already has an allowed_packages grant on this secret.`
}

export function createPackageSecretAccessDeniedBatchMessage(
	entries: Array<PackageApprovalEntry>,
	options: { bulkApprovalUrl?: string | null } = {},
) {
	const bulkApprovalUrl = options.bulkApprovalUrl?.trim() || null
	const payload = JSON.stringify({
		entries,
		...(bulkApprovalUrl ? { bulkApprovalUrl } : {}),
	})
	return `${packageBatchDeniedPrefix} ${payload}`
}

function parseHostApprovalEntries(value: unknown) {
	if (!Array.isArray(value)) return []
	const entries: Array<HostApprovalEntry> = []
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') continue
		if (
			typeof entry.secretName !== 'string' ||
			typeof entry.host !== 'string' ||
			typeof entry.approvalUrl !== 'string'
		) {
			continue
		}
		entries.push({
			secretName: entry.secretName,
			host: entry.host,
			approvalUrl: entry.approvalUrl,
		})
	}
	return entries
}

export function parseHostApprovalRequiredBatchMessage(message: string): {
	entries: Array<HostApprovalEntry>
	bulkApprovalUrl: string | null
} | null {
	if (!message.startsWith(hostBatchDeniedPrefix)) return null
	const raw = stripCredentialPlacementRefusalTag(
		message.slice(hostBatchDeniedPrefix.length),
	).trim()
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw)
		if (Array.isArray(parsed)) {
			const entries = parseHostApprovalEntries(parsed)
			return entries.length > 0 ? { entries, bulkApprovalUrl: null } : null
		}
		if (!parsed || typeof parsed !== 'object') return null
		const entries = parseHostApprovalEntries(
			'entries' in parsed ? parsed.entries : null,
		)
		if (entries.length === 0) return null
		const bulkApprovalUrl =
			'bulkApprovalUrl' in parsed &&
			typeof parsed.bulkApprovalUrl === 'string' &&
			parsed.bulkApprovalUrl.trim()
				? parsed.bulkApprovalUrl.trim()
				: null
		return { entries, bulkApprovalUrl }
	} catch {
		return null
	}
}

function parsePackageApprovalEntries(value: unknown) {
	if (!Array.isArray(value)) return []
	const entries: Array<PackageApprovalEntry> = []
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') continue
		if (
			typeof entry.secretName !== 'string' ||
			typeof entry.packageId !== 'string' ||
			typeof entry.approvalUrl !== 'string'
		) {
			continue
		}
		entries.push({
			secretName: entry.secretName,
			packageId: entry.packageId,
			kodyId: typeof entry.kodyId === 'string' ? entry.kodyId : null,
			packageName:
				typeof entry.packageName === 'string' ? entry.packageName : null,
			approvalUrl: entry.approvalUrl,
		})
	}
	return entries
}

export function parsePackageAccessRequiredBatchMessage(message: string): {
	entries: Array<PackageApprovalEntry>
	bulkApprovalUrl: string | null
} | null {
	if (!message.startsWith(packageBatchDeniedPrefix)) return null
	const raw = message.slice(packageBatchDeniedPrefix.length).trim()
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw)
		if (Array.isArray(parsed)) {
			const entries = parsePackageApprovalEntries(parsed)
			return entries.length > 0 ? { entries, bulkApprovalUrl: null } : null
		}
		if (!parsed || typeof parsed !== 'object') return null
		const entries = parsePackageApprovalEntries(
			'entries' in parsed ? parsed.entries : null,
		)
		if (entries.length === 0) return null
		const bulkApprovalUrl =
			'bulkApprovalUrl' in parsed &&
			typeof parsed.bulkApprovalUrl === 'string' &&
			parsed.bulkApprovalUrl.trim()
				? parsed.bulkApprovalUrl.trim()
				: null
		return { entries, bulkApprovalUrl }
	} catch {
		return null
	}
}

export function parseMissingSecretMessage(message: string) {
	const match = message.match(missingSecretRegex)
	if (!match?.[1]) return null
	return {
		secretName: match[1],
	}
}

function parseSecretErrorScope(value: string): SecretScope | null {
	switch (value) {
		case 'session':
		case 'package':
		case 'user':
			return value
		default:
			return null
	}
}

export function parseSecretScopeUnavailableMessage(message: string) {
	const match = message.match(secretScopeUnavailableRegex)
	if (!match?.[1] || !match[2]) return null
	const scope = parseSecretErrorScope(match[2])
	if (!scope) return null
	const label = match[4] ?? null
	const usesPackageId = Boolean(match[3])
	// Only search guidance after the visibility marker so a secret name that
	// happens to contain the missing-context phrase cannot flip the parser.
	const visibilityMarker = ' and is not visible from this runtime.'
	const visibilityIndex = message.indexOf(visibilityMarker, match[0].length)
	const guidance = visibilityIndex === -1 ? '' : message.slice(visibilityIndex)
	return {
		secretName: match[1],
		scope,
		packageName: usesPackageId ? null : label,
		packageId: usesPackageId ? label : null,
		// Anchor to the fixed terminal sentence so an interpolated package
		// name or runtime label that happens to contain the short phrase
		// cannot flip missing-context detection.
		missingPackageContext: guidance.endsWith(
			" Do not widen the secret's scope to work around a missing package context.",
		),
	}
}

export function parseHostApprovalRequiredMessage(message: string) {
	const match = message.match(hostApprovalRequiredRegex)
	if (!match?.[1] || !match?.[2]) return null
	return {
		secretName: match[1],
		host: match[2],
	}
}

export function parsePackageAccessRequiredMessage(message: string) {
	const match = message.match(packageAccessRequiredRegex)
	if (!match?.[1] || !match?.[2]) return null
	return {
		secretName: match[1],
		packageName: match[2],
	}
}

export function isSecretAuthRequiredMessage(message: string) {
	return secretAuthRequiredMessages.has(message)
}
