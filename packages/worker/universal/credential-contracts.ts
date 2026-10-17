/**
 * Shared shapes and URL codecs for credential mappings, the approval page,
 * and credential creation links. The contract is
 * docs/contributing/contracts/credential-mappings-api.md; the client and the
 * server both import these so neither drifts from it.
 *
 * Nothing here carries a credential value.
 */
import { parsePersonId } from '@kody-internal/shared/owner-person-ids.ts'

export const credentialKinds = [
	'secret',
	'oauth',
	'mcp',
	'url',
	'login',
	'signing',
] as const
export type CredentialKind = (typeof credentialKinds)[number]

export function isCredentialKind(value: unknown): value is CredentialKind {
	return (credentialKinds as ReadonlyArray<unknown>).includes(value)
}

/** Kinds a need without a declared `kind` accepts (any fetch-capable one). */
export const fetchCapableCredentialKinds = [
	'secret',
	'oauth',
	'login',
] as const satisfies ReadonlyArray<CredentialKind>

export const credentialScopes = ['org', 'personal'] as const
export type CredentialScope = (typeof credentialScopes)[number]

export type CredentialRef = {
	id: string
	name: string
	scope: CredentialScope
	kind: CredentialKind
}

/** A pick as an agent or a form sends it: by name (optionally scoped) or id. */
export type CredentialPick =
	| { name: string; scope?: CredentialScope }
	| { id: string }

export const credentialMappingLayers = ['org', 'mine'] as const
type CredentialMappingLayer = (typeof credentialMappingLayers)[number]

export const credentialTriggerKinds = [
	'cron',
	'subscription',
	'webhook',
] as const
export type CredentialTriggerKind = (typeof credentialTriggerKinds)[number]
export type CredentialTriggerRef = {
	kind: CredentialTriggerKind
	name: string
	/**
	 * Webhook only: the minted endpoint to Approve. Omit for legacy links
	 * (oldest URL under the name) and for cron / subscription triggers.
	 */
	endpointId?: string
}

/**
 * Who an inbound-email subscription enablement runs for. The same vocabulary
 * as an enablement's `sender_kind`. `any_authenticated` stores no value.
 */
export const credentialProposalSenderKinds = [
	'member',
	'address',
	'domain',
	'any_authenticated',
] as const
type CredentialProposalSenderKind =
	(typeof credentialProposalSenderKinds)[number]

export type CredentialProposalSender = {
	kind: CredentialProposalSenderKind
	value: string | null
}

/** Subscription topics that run only through a per-sender approval. */
const inboundEmailApprovalTopics = [
	'email.message.received',
	'email.message.quarantined',
] as const

export function isInboundEmailApprovalTopic(name: string) {
	return (inboundEmailApprovalTopics as ReadonlyArray<string>).includes(name)
}

export type StoredCredentialMapping = {
	/** `[]` is "none on purpose". */
	credentials: Array<CredentialRef>
	/** Refs the viewer can no longer Use (deleted or Use revoked); ids only. */
	unusableIds: Array<string>
	updatedAt: string
	updatedBy: { username: string } | null
}

export type CredentialMappingSource =
	| 'call'
	| 'trigger'
	| 'mine'
	| 'org'
	| 'auto'
	| 'none'

export type EffectiveCredentialMappingStatus =
	| 'ready'
	| 'none'
	| 'unbound'
	| 'ambiguous'
	| 'unusable'

export type EffectiveCredentialMapping = {
	source: CredentialMappingSource
	status: EffectiveCredentialMappingStatus
	credentials: Array<CredentialRef>
	candidates: Array<CredentialRef>
	/** Absolute creation link; set when status is not `ready`. */
	createUrl: string | null
}

export type CredentialMappingTarget =
	| { type: 'default'; layer: CredentialMappingLayer }
	| {
			type: 'trigger'
			trigger: CredentialTriggerRef
			/**
			 * Edit this enablement. Omit for the viewer's sole (or first) live
			 * enablement of the trigger.
			 */
			enablementId?: string
			/**
			 * Create another enablement even when the viewer already has one
			 * (cron and non-email subscription only). Writes a new row; never
			 * reuses or deletes an existing enablement.
			 */
			createInstance?: boolean
	  }

export type CredentialMappingChange = {
	target: CredentialMappingTarget
	needKey: string
	/** `null` clears the override (inherit); `[]` is "none on purpose". */
	credentials: Array<CredentialPick> | null
}

/**
 * Session-only turn-on / turn-off for one of the viewer's enablements on the
 * package Triggers tab. `createInstance` mints another row when the viewer
 * already has one; omit it to reuse the existing enablementEnable path.
 */
export type PackageCredentialsEnablementAction = {
	trigger: CredentialTriggerRef
	state: 'on' | 'off'
	/** Required when turning off (or when targeting one of several). */
	enablementId?: string
	/** Turn on another instance; ignored when `state` is `off`. */
	createInstance?: boolean
}

/** A proposed change always sets picks; proposals cannot clear. */
export type CredentialMappingProposalChange = CredentialMappingChange & {
	credentials: Array<CredentialPick>
}

export type CredentialInjectView =
	| { kind: 'header'; name: string; format: string }
	| { kind: 'basic'; valueAs: 'username' | 'password'; other: string }
	| { kind: 'query'; param: string }

export type CredentialListItemStatus =
	| 'ok'
	| 'expired'
	| 'needs_attention'
	| 'disabled'

export type CredentialListItem = {
	id: string
	kind: CredentialKind
	name: string
	scope: CredentialScope
	provider: string | null
	description: string
	hosts: Array<string>
	inject: CredentialInjectView | null
	packageId: string | null
	lockedToPackageIds: Array<string>
	expiresAt: string | null
	createdAt: string
	updatedAt: string
	status: CredentialListItemStatus
	statusMessage: string | null
	mcp: { url: string; enabled: boolean } | null
}

export type CredentialListFilters = {
	q?: string
	kinds?: Array<CredentialKind>
	scope?: CredentialScope
	packageScoped?: boolean
	/** `true`: locked to any package; a string: locked to that package id. */
	locked?: true | string
}

export type CredentialListResponse = {
	ok: true
	credentials: Array<CredentialListItem>
}

export type PackageCredentialNeedView = {
	key: string
	kind: CredentialKind | null
	provider: string
	description: string
	multiple: boolean
	from?: string
	defaults: {
		org: StoredCredentialMapping | null
		mine: StoredCredentialMapping | null
	}
	effective: EffectiveCredentialMapping
	options: Array<CredentialRef>
	createUrl: string
}

/** One of the viewer's live enablements of a declared trigger. */
export type PackageTriggerInstanceView = {
	enablement: {
		id: string
		state: 'on' | 'paused' | 'off'
		enabledByYou: boolean
	}
	/** Only the enabler edits this instance's credential mappings. */
	canEdit: boolean
	/** Webhook only: minted endpoint id this enablement runs. */
	endpointId?: string | null
	/** Webhook only: short label for the minted URL this enablement runs. */
	instanceLabel?: string | null
	mappings: Array<{
		needKey: string
		override: StoredCredentialMapping | null
		effective: EffectiveCredentialMapping
	}>
}

export type PackageTriggerView = {
	trigger: CredentialTriggerRef
	/** Webhook endpoint id, job id, or package id; null for an unminted webhook. */
	instanceId: string | null
	/**
	 * The viewer's primary enablement (first live), or the webhook's single
	 * enabler when that is someone else. Prefer {@link instances} when listing
	 * every copy the viewer holds.
	 */
	enablement: {
		id: string
		state: 'on' | 'paused' | 'off'
		enabledByYou: boolean
	} | null
	/** Only the enabler edits; true when the viewer is (or would become) it. */
	canEdit: boolean
	/**
	 * Mappings for {@link enablement}. Empty when withheld or when the trigger
	 * is off. Prefer each entry in {@link instances} for multi-instance UIs.
	 */
	mappings: Array<{
		needKey: string
		override: StoredCredentialMapping | null
		effective: EffectiveCredentialMapping
	}>
	/**
	 * Every live enablement the viewer holds for this declared trigger (or one
	 * read-only webhook entry when someone else enabled it). Empty when off.
	 */
	instances: Array<PackageTriggerInstanceView>
	/**
	 * The viewer may turn on another copy with its own credential mapping
	 * (cron and non-email subscriptions), or mint another labeled webhook URL
	 * in Settings. Inbound email uses sender-scoped Approve instead.
	 */
	canAddInstance: boolean
}

export type PackageCredentialsIncomplete = {
	needKey: string
	where:
		| { type: 'default' }
		| {
				type: 'trigger'
				trigger: CredentialTriggerRef
				/** Set when more than one of the viewer's instances is incomplete. */
				enablementId?: string
		  }
	status: 'unbound' | 'ambiguous' | 'unusable'
}

export type PackageCredentialsView = {
	ok: true
	package: { id: string; kodyId: string; canManage: boolean }
	needs: Array<PackageCredentialNeedView>
	triggers: Array<PackageTriggerView>
	locked: Array<CredentialListItem>
	incomplete: Array<PackageCredentialsIncomplete>
}

/** One change POST credentials.json refused; nothing was written. */
export type PackageCredentialsWriteError = {
	needKey: string
	target: CredentialMappingTarget
	code: CredentialApprovalErrorCode
	message: string
	createUrl?: string
}

export type PackageCredentialsWriteFailure = {
	ok: false
	errors: Array<PackageCredentialsWriteError>
}

export const credentialApprovalErrorCodes = [
	'need_unknown',
	'trigger_unknown',
	'credential_not_found',
	'credential_ambiguous',
	'kind_mismatch',
	'provider_mismatch',
	'too_many',
	'not_allowed',
	'webhook_not_minted',
	'webhook_other_enabler',
	'email_approval_required',
] as const
export type CredentialApprovalErrorCode =
	(typeof credentialApprovalErrorCodes)[number]

export type CredentialApprovalChangeView = {
	target: CredentialMappingTarget
	needKey: string
	need: {
		kind: CredentialKind | null
		provider: string
		description: string
		multiple: boolean
	} | null
	before: Array<CredentialRef> | null
	/** Stored refs left out of `before` because the viewer can no longer Use them; ids only. */
	beforeUnusableIds: Array<string>
	after: Array<CredentialRef>
	willEnable: boolean
	error: {
		code: CredentialApprovalErrorCode
		message: string
		createUrl?: string
	} | null
}

/** A trigger the proposal turns on with no mapping of its own. */
export type CredentialApprovalEnableView = {
	trigger: CredentialTriggerRef
	/** False when it is already on (or paused) for you; Approve is a no-op. */
	willEnable: boolean
	error: {
		code: CredentialApprovalErrorCode
		message: string
	} | null
}

export type CredentialApprovalView = {
	ok: true
	package: { id: string; kodyId: string }
	reason: string | null
	canApprove: boolean
	fingerprint: string
	changes: Array<CredentialApprovalChangeView>
	enable: Array<CredentialApprovalEnableView>
	/**
	 * Sender stored on an inbound-email enablement this proposal turns on.
	 * Null when the link names no sender.
	 */
	sender: CredentialProposalSender | null
	errors: Array<string>
}

/**
 * `pause.resourceType` of an enablement paused because a credential its
 * trigger mapping names is gone or no longer usable by the enabler.
 * `resourceId` is the need key; `credentialId` the missing credential.
 */
export const enablementMappingPauseResourceType = 'credential-mapping'

export function describeCredentialMappingTarget(
	target: CredentialMappingTarget,
): string {
	switch (target.type) {
		case 'default':
			return target.layer === 'org' ? 'org default' : 'your default'
		case 'trigger':
			return `${target.trigger.kind} "${target.trigger.name}"`
		default: {
			const exhaustive: never = target
			throw new Error(`Unhandled mapping target: ${String(exhaustive)}`)
		}
	}
}

// ---------------------------------------------------------------------------
// Creation link: /connect/credential
// ---------------------------------------------------------------------------

/**
 * The org-less creation link. It redirects to the signed-in person's signup
 * org; links that know their org use {@link orgCredentialCreatePath}.
 */
export const credentialCreatePath = '/connect/credential'

/** The creation page for one org: the org the link's MCP connection or CLI is bound to. */
export function orgCredentialCreatePath(orgSlug: string) {
	return `/@${encodeURIComponent(orgSlug)}/-/credentials/new`
}

type CredentialKindMode = 'hint' | 'required'

export type CredentialCreateLinkInput = {
	/** The org the credential is saved in. Omit only when no org is known. */
	orgSlug?: string | null
	kind?: CredentialKind | null
	kindMode?: CredentialKindMode
	name?: string | null
	provider?: string | null
	description?: string | null
	allowedHosts?: ReadonlyArray<string>
	/** The package (kody id) and need key the credential is for. */
	packageKodyId?: string | null
	needKey?: string | null
	/** A Key only this saved package (id) can read. */
	packageScopedTo?: string | null
	/** UTC ISO timestamp or YYYY-MM-DD. */
	expiresAt?: string | null
	/** Saved package ids the Key is locked to. */
	allowedPackages?: ReadonlyArray<string>
	/** Passed through to the reused form (secret-set or OAuth params). */
	extra?: Record<string, string>
}

const createLinkKnownParams = new Set([
	'kind',
	'kindMode',
	'name',
	'provider',
	'description',
	'allowedHosts',
	'forPackage',
	'need',
	'scope',
	'packageId',
	'expiresAt',
	'allowedPackages',
])

function commaList(values: ReadonlyArray<string> | undefined) {
	return [...new Set((values ?? []).map((value) => value.trim()))].filter(
		Boolean,
	)
}

function trimmed(value: string | null | undefined) {
	const text = value?.trim()
	return text ? text : null
}

export function buildCredentialCreateHref(
	input: CredentialCreateLinkInput,
): string {
	const params = new URLSearchParams()
	const kind = input.kind ?? null
	if (kind) {
		params.set('kind', kind)
		if (input.kindMode === 'required') params.set('kindMode', 'required')
	}
	const set = (key: string, value: string | null | undefined) => {
		const text = trimmed(value)
		if (text) params.set(key, text)
	}
	set('name', input.name)
	set('provider', input.provider)
	set('description', input.description)
	const hosts = commaList(input.allowedHosts)
	if (hosts.length > 0) params.set('allowedHosts', hosts.join(','))
	set('forPackage', input.packageKodyId)
	set('need', input.needKey)
	const packageScopedTo = trimmed(input.packageScopedTo)
	if (packageScopedTo) {
		params.set('scope', 'package')
		params.set('packageId', packageScopedTo)
	}
	set('expiresAt', input.expiresAt)
	const allowedPackages = commaList(input.allowedPackages)
	if (!packageScopedTo && allowedPackages.length > 0) {
		params.set('allowedPackages', allowedPackages.join(','))
	}
	for (const [key, value] of Object.entries(input.extra ?? {})) {
		if (createLinkKnownParams.has(key)) continue
		params.set(key, value)
	}
	const orgSlug = trimmed(input.orgSlug)
	const path = orgSlug ? orgCredentialCreatePath(orgSlug) : credentialCreatePath
	const query = params.toString()
	return query ? `${path}?${query}` : path
}

/** The creation link as an absolute URL on `baseUrl`'s origin. */
export function buildCredentialCreateUrl(
	baseUrl: string,
	input: CredentialCreateLinkInput,
): string {
	return new URL(buildCredentialCreateHref(input), baseUrl).toString()
}

export type ParsedCredentialCreateQuery = {
	kind: CredentialKind | null
	/** True only when `kindMode=required` and `kind` is a known kind. */
	kindLocked: boolean
	name: string | null
	provider: string | null
	description: string | null
	allowedHosts: Array<string>
	packageKodyId: string | null
	needKey: string | null
	/** `scope=package&packageId=…`: a Key only that saved package can read. */
	packageScopedTo: string | null
	/** True when `scope=package` came without a `packageId`. */
	packageScopeMissingId: boolean
	/** The raw `expiresAt`; the page validates it. */
	expiresAt: string | null
	/** Saved package ids the Key is locked to (ignored for package Keys). */
	allowedPackages: Array<string>
	/** Every other param, for the reused form. */
	passthrough: URLSearchParams
}

function readCommaList(search: URLSearchParams, key: string) {
	return commaList(search.getAll(key).flatMap((value) => value.split(',')))
}

export function parseCredentialCreateQuery(
	search: URLSearchParams,
): ParsedCredentialCreateQuery {
	const rawKind = trimmed(search.get('kind'))
	const kind = isCredentialKind(rawKind) ? rawKind : null
	const passthrough = new URLSearchParams()
	for (const [key, value] of search) {
		if (!createLinkKnownParams.has(key)) passthrough.append(key, value)
	}
	const scope = trimmed(search.get('scope'))
	const packageId = trimmed(search.get('packageId'))
	// A bare `packageId` means a package Key, as on the legacy intake page.
	const packageScope = scope === 'package' || (scope === null && !!packageId)
	return {
		kind,
		kindLocked: kind !== null && search.get('kindMode') === 'required',
		name: trimmed(search.get('name')),
		provider: trimmed(search.get('provider')),
		description: trimmed(search.get('description')),
		allowedHosts: readCommaList(search, 'allowedHosts'),
		packageKodyId: trimmed(search.get('forPackage')),
		needKey: trimmed(search.get('need')),
		packageScopedTo: packageScope ? packageId : null,
		packageScopeMissingId: packageScope && !packageId,
		expiresAt: trimmed(search.get('expiresAt')),
		allowedPackages: packageScope
			? []
			: readCommaList(search, 'allowedPackages'),
		passthrough,
	}
}

// ---------------------------------------------------------------------------
// Proposal / approval link: /@:username/:kodyId/approve-credentials
// ---------------------------------------------------------------------------

export const maxCredentialProposalValues = 64
export const maxCredentialProposalReasonLength = 500

function credentialApprovalPath(input: {
	username: string
	kodyId: string
}): string {
	return `/@${encodeURIComponent(input.username)}/${encodeURIComponent(input.kodyId)}/approve-credentials`
}

const reservedPickPrefix = /^(org|personal|id|name):/

function formatCredentialPick(pick: CredentialPick): string {
	if ('id' in pick) return `id:${pick.id}`
	if (pick.scope) return `${pick.scope}:${pick.name}`
	// A blank value means "none on purpose"; `name:` keeps a blank name invalid.
	// The parser trims first, so check the prefix on the trimmed name.
	const trimmedName = pick.name.trim()
	return reservedPickPrefix.test(trimmedName) || !trimmedName
		? `name:${pick.name}`
		: pick.name
}

/**
 * `work`, `org:work`, `personal:work`, `id:<id>`, or `name:<name>` for a name
 * that itself starts with one of those prefixes. Null when it is not a pick.
 */
export function parseCredentialPick(value: string): CredentialPick | null {
	const text = value.trim()
	if (!text) return null
	const prefix = reservedPickPrefix.exec(text)?.[1]
	if (!prefix) return { name: text }
	const rest = text.slice(prefix.length + 1).trim()
	if (!rest) return null
	switch (prefix) {
		case 'id':
			return { id: rest }
		case 'org':
		case 'personal':
			return { name: rest, scope: prefix }
		default:
			return { name: rest }
	}
}

/** `%`, `[`, and `]` inside a bracket segment survive query decoding. */
function encodeBracketSegment(value: string) {
	return value
		.replaceAll('%', '%25')
		.replaceAll('[', '%5B')
		.replaceAll(']', '%5D')
}

function decodeBracketSegment(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

function proposalParamName(change: CredentialMappingChange): string {
	const { target } = change
	switch (target.type) {
		case 'default':
			return `${target.layer === 'org' ? 'default' : 'mine'}[${encodeBracketSegment(change.needKey)}]`
		case 'trigger':
			return `trigger[${target.trigger.kind}:${encodeBracketSegment(target.trigger.name)}][${encodeBracketSegment(change.needKey)}]`
		default: {
			const exhaustive: never = target
			throw new Error(`Unhandled mapping target: ${String(exhaustive)}`)
		}
	}
}

function buildCredentialProposalSearch(input: {
	changes: ReadonlyArray<CredentialMappingProposalChange>
	enable?: ReadonlyArray<CredentialTriggerRef>
	reason?: string | null
	sender?: CredentialProposalSender | null
}): URLSearchParams {
	const params = new URLSearchParams()
	for (const trigger of input.enable ?? []) {
		const value =
			trigger.kind === 'webhook' && trigger.endpointId
				? `${trigger.kind}:${trigger.name}:${trigger.endpointId}`
				: `${trigger.kind}:${trigger.name}`
		params.append('enable', value)
	}
	if (input.sender) {
		params.set('sender_kind', input.sender.kind)
		if (input.sender.value) params.set('sender_value', input.sender.value)
	}
	for (const change of input.changes) {
		const name = proposalParamName(change)
		if (change.credentials.length === 0) {
			params.append(name, '')
			continue
		}
		for (const pick of change.credentials) {
			params.append(name, formatCredentialPick(pick))
		}
	}
	const reason = trimmed(input.reason)
	if (reason) {
		params.set('reason', reason.slice(0, maxCredentialProposalReasonLength))
	}
	return params
}

/** The recorded agent proposal an approval link names; not a mapping param. */
const credentialProposalIdParam = 'proposal'

export function buildCredentialApprovalHref(input: {
	username: string
	kodyId: string
	changes: ReadonlyArray<CredentialMappingProposalChange>
	/** Triggers to turn on even when they map nothing (a webhook, say). */
	enable?: ReadonlyArray<CredentialTriggerRef>
	/**
	 * Sender rule stored when this link turns on an inbound-email
	 * subscription. Omitted for every other trigger.
	 */
	sender?: CredentialProposalSender | null
	reason?: string | null
	/** The recorded agent proposal this link approves. */
	proposalId?: string | null
}): string {
	const path = credentialApprovalPath(input)
	const params = buildCredentialProposalSearch(input)
	if (input.proposalId) params.set(credentialProposalIdParam, input.proposalId)
	const query = params.toString()
	return query ? `${path}?${query}` : path
}

export function readCredentialProposalId(
	search: URLSearchParams,
): string | null {
	return trimmed(search.get(credentialProposalIdParam)) || null
}

export type ParsedCredentialProposal = {
	changes: Array<CredentialMappingProposalChange>
	enable: Array<CredentialTriggerRef>
	/** Null when the link names no sender. */
	sender: CredentialProposalSender | null
	reason: string | null
	errors: Array<string>
}

/**
 * `webhook:incoming` or `webhook:incoming:<endpointId>` (split at the first
 * colon for kind; for webhooks a second colon names the endpoint). Null when
 * it is not a trigger ref.
 */
function parseCredentialTriggerRef(value: string): CredentialTriggerRef | null {
	const text = value.trim()
	const colon = text.indexOf(':')
	if (colon < 0) return null
	const kind = text.slice(0, colon).trim()
	const rest = text.slice(colon + 1).trim()
	if (!rest) return null
	if (!(credentialTriggerKinds as ReadonlyArray<string>).includes(kind)) {
		return null
	}
	if (kind === 'webhook') {
		const endpointColon = rest.indexOf(':')
		if (endpointColon >= 0) {
			const name = rest.slice(0, endpointColon).trim()
			const endpointId = rest.slice(endpointColon + 1).trim()
			if (!name || !endpointId) return null
			return { kind: 'webhook', name, endpointId }
		}
	}
	return { kind: kind as CredentialTriggerKind, name: rest }
}

const defaultParamPattern = /^(default|mine)\[([^\]]+)\]$/
const triggerParamPattern =
	/^trigger\[(cron|subscription|webhook):([^\]]+)\]\[([^\]]+)\]$/

function parseProposalParamName(
	name: string,
): Omit<CredentialMappingProposalChange, 'credentials'> | null {
	const defaultMatch = defaultParamPattern.exec(name)
	if (defaultMatch) {
		const [, layer, needKey] = defaultMatch
		return {
			target: { type: 'default', layer: layer === 'default' ? 'org' : 'mine' },
			needKey: decodeBracketSegment(needKey!).trim(),
		}
	}
	const triggerMatch = triggerParamPattern.exec(name)
	if (triggerMatch) {
		const [, kind, triggerName, needKey] = triggerMatch
		return {
			target: {
				type: 'trigger',
				trigger: {
					kind: kind as CredentialTriggerKind,
					name: decodeBracketSegment(triggerName!).trim(),
				},
			},
			needKey: decodeBracketSegment(needKey!).trim(),
		}
	}
	return null
}

const proposalAddressPattern = /<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i

function normalizeProposalAddress(value: string) {
	const match = value.trim().match(proposalAddressPattern)
	const address = match?.[1]?.trim().toLowerCase() ?? ''
	return address.length > 0 ? address : null
}

function normalizeProposalDomain(value: string) {
	const domain = value.trim().toLowerCase().replace(/^@+/, '')
	if (
		!domain ||
		domain.includes('@') ||
		/\s/.test(domain) ||
		!domain.includes('.') ||
		/[%_*]/.test(domain)
	) {
		return null
	}
	return domain
}

export function normalizeProposalSenderValue(
	kind: Exclude<CredentialProposalSenderKind, 'any_authenticated'>,
	value: string,
) {
	switch (kind) {
		case 'member':
			return parsePersonId(value.trim().toLowerCase())
		case 'address':
			return normalizeProposalAddress(value)
		case 'domain':
			return normalizeProposalDomain(value)
		default: {
			const exhaustive: never = kind
			throw new Error(`Unhandled sender kind: ${String(exhaustive)}`)
		}
	}
}

/**
 * `sender_kind` plus `sender_value`. Absent params are no sender. A kind
 * without a usable value, or a value without a kind, is an error.
 * `any_authenticated` ignores `sender_value`.
 */
function parseProposalSender(
	search: URLSearchParams,
	errors: Array<string>,
): CredentialProposalSender | null {
	const kindRaw = search.get('sender_kind')
	const valueRaw = search.get('sender_value')
	const kindText = kindRaw?.trim() ?? ''
	const valueText = valueRaw?.trim() ?? ''
	if (!kindText && !valueText) return null
	if (!kindText) {
		errors.push(
			'"sender_value" needs a sender_kind (member, address, domain, or any_authenticated).',
		)
		return null
	}
	if (
		!(credentialProposalSenderKinds as ReadonlyArray<string>).includes(kindText)
	) {
		errors.push(
			`"sender_kind=${kindRaw}" is not a sender; use member, address, domain, or any_authenticated.`,
		)
		return null
	}
	const kind = kindText as CredentialProposalSenderKind
	if (kind === 'any_authenticated') return { kind, value: null }
	const value = normalizeProposalSenderValue(kind, valueRaw ?? '')
	if (!value) {
		errors.push(
			`"${kind === 'member' ? 'sender_kind=member' : `sender_kind=${kind}`}" needs a sender_value${
				kind === 'member'
					? ' that is a person id.'
					: kind === 'address'
						? ' that is an email address.'
						: ' that is a bare domain.'
			}`,
		)
		return null
	}
	return { kind, value }
}

/**
 * Reads a proposal from the approval page's query. Values for one target and
 * need accumulate in order, even when their param names are spelled
 * differently; only a lone empty value maps the need to `[]`. A value that is
 * not a pick, or an empty value beside others, is an error and drops that
 * change. Params that look like mapping params but do not parse are reported;
 * other params are ignored. `sender_kind` and `sender_value` name the sender
 * an inbound-email enablement runs for.
 */
export function parseCredentialApprovalQuery(
	search: URLSearchParams,
): ParsedCredentialProposal {
	const errors: Array<string> = []
	const sender = parseProposalSender(search, errors)
	const byTarget = new Map<
		string,
		{
			name: string
			change: Omit<CredentialMappingProposalChange, 'credentials'>
			values: Array<string>
		}
	>()
	const enableByKey = new Map<string, CredentialTriggerRef>()
	for (const [name, value] of search) {
		if (name === 'reason') continue
		if (name === 'enable') {
			const trigger = parseCredentialTriggerRef(value)
			if (!trigger) {
				errors.push(
					`"enable=${value}" is not a trigger; use <cron|subscription|webhook>:<name>.`,
				)
				continue
			}
			enableByKey.set(`${trigger.kind}:${trigger.name}`, trigger)
			continue
		}
		const parsed = parseProposalParamName(name)
		if (!parsed) {
			if (/^(default|mine|trigger)/.test(name)) {
				errors.push(`"${name}" is not a mapping parameter.`)
			}
			continue
		}
		const triggerName =
			parsed.target.type === 'trigger' ? parsed.target.trigger.name : null
		if (!parsed.needKey || triggerName === '') {
			errors.push(`"${name}" is missing a name.`)
			continue
		}
		const key = JSON.stringify([parsed.target, parsed.needKey])
		const entry = byTarget.get(key) ?? { name, change: parsed, values: [] }
		entry.values.push(value)
		byTarget.set(key, entry)
	}
	const valueCount = byTarget.size + enableByKey.size
	if (valueCount > maxCredentialProposalValues) {
		return {
			changes: [],
			enable: [],
			sender,
			reason: null,
			errors: [
				`A proposal holds at most ${maxCredentialProposalValues} mapping parameters; this one has ${valueCount}.`,
			],
		}
	}
	const changes: Array<CredentialMappingProposalChange> = []
	for (const { name, change, values } of byTarget.values()) {
		if (values.length === 1 && !values[0]!.trim()) {
			changes.push({ ...change, credentials: [] })
			continue
		}
		const credentials: Array<CredentialPick> = []
		const invalid: Array<string> = []
		for (const value of values) {
			const pick = parseCredentialPick(value)
			if (pick) credentials.push(pick)
			else invalid.push(value)
		}
		if (invalid.length > 0) {
			errors.push(
				invalid.some((value) => !value.trim())
					? `"${name}" mixes an empty value (none on purpose) with credentials.`
					: `"${name}" has a value that is not a credential pick: ${invalid
							.map((value) => JSON.stringify(value))
							.join(', ')}.`,
			)
			continue
		}
		changes.push({ ...change, credentials })
	}
	const reason = trimmed(search.get('reason'))
	return {
		changes,
		enable: [...enableByKey.values()],
		sender,
		reason: reason ? reason.slice(0, maxCredentialProposalReasonLength) : null,
		errors,
	}
}
