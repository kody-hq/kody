/**
 * The publish pause for changed credential needs (ADR 0068 amendment
 * 2026-10-13, scoped 2026-10-15). For an **internet-visible** package, a
 * publish whose needs closure gains a key, changes a key's kind, provider,
 * or `multiple`, or turns on a key's `ownerCredentialForVisitors`, waits for
 * the owner in the shared approval queue while the
 * previously published commit keeps serving. Private packages skip this pause
 * (owner publish proceeds); going internet-visible still uses the
 * `went_public` / capability approval path, which lists declared credentials.
 * Dropping a need or editing its description never pauses, and neither does a
 * first publish.
 */
import * as Sentry from '@sentry/cloudflare'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { isCredentialKind } from '#universal/credential-contracts.ts'
import { credentialKindLabel } from '#universal/credentials-list.ts'
import { enqueuePackageApprovalRequest } from '#worker/package-capabilities/approval-requests-repo.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import {
	computeCredentialNeedsClosure,
	loadPublishedCredentialNeeds,
	packageSourceFiles,
} from './credential-needs-closure.ts'
import { type CredentialNeed } from './credential-needs.ts'

type NeedShape = Pick<
	CredentialNeed,
	'kind' | 'provider' | 'package' | 'multiple' | 'ownerCredentialForVisitors'
>

export type CredentialNeedChange =
	| { key: string; change: 'added'; after: NeedShape; from?: string }
	| {
			key: string
			change: 'changed'
			before: NeedShape
			after: NeedShape
			from?: string
	  }

/**
 * A session publish that paused before touching the source branch. Approval
 * re-runs it on the same session with the same publish options.
 */
export type PausedSessionPublish = {
	sessionId: string
	force: boolean
	destructiveOverwriteConfirmed: boolean
	privateVisibilityChangeConfirmed: boolean
	expectedPackageScope?: string
}

/**
 * An external-ref publish that paused with its commit already on HEAD.
 * Approval publishes that commit with the same overwrite options.
 */
export type PausedExternalPublish = {
	allowForce: boolean
	destructiveOverwriteConfirmed: boolean
}

export type CredentialNeedsApprovalRequired = {
	requestId: string
	packageId: string
	packageName: string
	kodyId: string
	pendingCommit: string
	changes: Array<CredentialNeedChange>
	message: string
}

function shape(need: CredentialNeed): NeedShape {
	return {
		...(need.kind ? { kind: need.kind } : {}),
		provider: need.provider,
		...(need.package ? { package: need.package } : {}),
		multiple: need.multiple,
		...(need.ownerCredentialForVisitors
			? { ownerCredentialForVisitors: true as const }
			: {}),
	}
}

/** Needs `after` adds or reshapes relative to `before`, by key. */
export function diffCredentialNeeds(
	before: ReadonlyArray<CredentialNeed>,
	after: ReadonlyArray<CredentialNeed>,
): Array<CredentialNeedChange> {
	const previous = new Map(before.map((need) => [need.key, need]))
	const changes: Array<CredentialNeedChange> = []
	for (const need of [...after].sort((a, b) => a.key.localeCompare(b.key))) {
		const from = need.from ? { from: need.from } : {}
		const prior = previous.get(need.key)
		if (!prior) {
			changes.push({
				key: need.key,
				change: 'added',
				after: shape(need),
				...from,
			})
			continue
		}
		// Turning visitor use off only narrows, like dropping a need.
		const sharesWithVisitors =
			need.ownerCredentialForVisitors === true &&
			prior.ownerCredentialForVisitors !== true
		if (
			prior.kind !== need.kind ||
			prior.provider !== need.provider ||
			prior.package !== need.package ||
			prior.multiple !== need.multiple ||
			sharesWithVisitors
		) {
			changes.push({
				key: need.key,
				change: 'changed',
				before: shape(prior),
				after: shape(need),
				...from,
			})
		}
	}
	return changes
}

function describeNeedKind(kind: NeedShape['kind']) {
	if (kind === undefined) return 'any fetch-capable kind'
	if (kind === 'secret-provider') return 'secret provider'
	return isCredentialKind(kind) ? credentialKindLabel(kind) : kind
}

function describeNeedTail(need: NeedShape) {
	const viaMultiple = need.multiple ? ' (several allowed)' : ''
	const forVisitors = need.ownerCredentialForVisitors
		? ' (app visitors may use your credential)'
		: ''
	if (need.package) return `secret provider package ${need.package}`
	return `${describeNeedKind(need.kind)} from ${need.provider}${viaMultiple}${forVisitors}`
}

/**
 * Plain-language change line for the approval UI and agent pause message.
 * Example: `This version adds a credential need: NEXTDNS_API_KEY Key from nextdns`
 */
export function describeCredentialNeedChange(change: CredentialNeedChange) {
	const via = change.from ? ` (via ${change.from})` : ''
	switch (change.change) {
		case 'added':
			return `This version adds a credential need: ${change.key} ${describeNeedTail(change.after)}${via}`
		case 'changed':
			return `This version changes the credential need ${change.key}${via}: was ${describeNeedTail(change.before)}, now ${describeNeedTail(change.after)}`
		default: {
			const exhaustive: never = change
			throw new Error(`Unknown need change: ${String(exhaustive)}`)
		}
	}
}

export function describeCredentialNeedChanges(
	changes: ReadonlyArray<CredentialNeedChange>,
) {
	return changes.map(describeCredentialNeedChange).join('. ')
}

export function createCredentialNeedsApprovalMessage(input: {
	packageName: string
	changes: ReadonlyArray<CredentialNeedChange>
	approvalUrl: string | null
}) {
	const where = input.approvalUrl
		? `The owner approves it at ${input.approvalUrl}.`
		: 'The owner approves it on the package approval page.'
	return `Package "${input.packageName}" changed its credential needs. ${describeCredentialNeedChanges(input.changes)}. This publish waits for approval, and the previously published version keeps running until then. ${where}`
}

async function computeNeeds(input: {
	env: Env
	source: EntitySourceRow
	files: Record<string, string>
}) {
	const { files, manifestContent } = packageSourceFiles(input)
	if (typeof manifestContent !== 'string') return null
	const manifest = parseAuthoredPackageJson({
		content: manifestContent,
		mode: 'published',
	})
	const [before, after] = await Promise.all([
		loadPublishedCredentialNeeds({
			env: input.env,
			userId: input.source.user_id,
			sourceId: input.source.id,
		}),
		computeCredentialNeedsClosure({
			env: input.env,
			userId: input.source.user_id,
			manifest,
			files,
		}).then(({ needs }) => needs),
	])
	return { before, after }
}

/**
 * Queues an approval and returns it when publishing `pendingCommit` would
 * change an **internet-visible** package's credential needs; null when the
 * publish may proceed (including private packages, first publishes, and
 * unchanged/removed needs). Fails open: a closure that cannot be computed is
 * reported and never blocks a publish.
 */
export async function requireCredentialNeedsApproval(input: {
	env: Env
	source: EntitySourceRow
	pendingCommit: string
	files: Record<string, string>
	requestedByUserId?: string | null
	pausedSession?: PausedSessionPublish
	pausedExternalPublish?: PausedExternalPublish
}): Promise<CredentialNeedsApprovalRequired | null> {
	if (input.source.entity_kind !== 'package') return null
	if (!input.source.published_commit) return null
	if (input.source.published_commit === input.pendingCommit) return null
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.source.user_id as OwnerId,
		packageId: input.source.entity_id,
	})
	if (!savedPackage) return null
	// Private packages: owner publish proceeds without this pause. Credential
	// needs still surface when the package becomes internet-visible
	// (`went_public` / capability approval). Runtime credential checks and
	// host/secret approval are unchanged.
	if (!savedPackage.isInternetVisible) return null
	let needs: Awaited<ReturnType<typeof computeNeeds>>
	try {
		needs = await computeNeeds(input)
	} catch (error) {
		Sentry.captureException(error, {
			tags: { scope: 'credentials.needs-approval.compute' },
			extra: { sourceId: input.source.id, pendingCommit: input.pendingCommit },
		})
		return null
	}
	if (!needs) return null
	const changes = diffCredentialNeeds(needs.before, needs.after)
	if (changes.length === 0) return null
	const request = await enqueuePackageApprovalRequest(input.env.APP_DB, {
		packageId: savedPackage.id,
		ownerUserId: input.source.user_id,
		reason: 'credential_needs_changed',
		pendingCommit: input.pendingCommit,
		baseCommit: input.source.published_commit,
		details: {
			changes,
			...(input.pausedSession ? { session: input.pausedSession } : {}),
			...(input.pausedExternalPublish
				? { externalPublish: input.pausedExternalPublish }
				: {}),
		},
		requestedByUserId: input.requestedByUserId ?? null,
	})
	return {
		requestId: request.id,
		packageId: savedPackage.id,
		packageName: savedPackage.name,
		kodyId: savedPackage.kodyId,
		pendingCommit: input.pendingCommit,
		changes,
		message: createCredentialNeedsApprovalMessage({
			packageName: savedPackage.name,
			changes,
			approvalUrl: null,
		}),
	}
}

/** Thrown by publish lanes that report failures as errors (`packageSave`). */
export class PackageCredentialNeedsApprovalError extends Error {
	readonly approval: CredentialNeedsApprovalRequired

	constructor(approval: CredentialNeedsApprovalRequired) {
		super(approval.message)
		this.name = 'PackageCredentialNeedsApprovalError'
		this.approval = approval
	}
}

export function readCredentialNeedChanges(
	details: Record<string, unknown>,
): Array<CredentialNeedChange> {
	const changes = details['changes']
	return Array.isArray(changes) ? (changes as Array<CredentialNeedChange>) : []
}

const pausedSessionMovedMarker = 'no longer holds paused commit'

export function pausedSessionMovedMessage(sessionId: string, commit: string) {
	return `Session ${sessionId} ${pausedSessionMovedMarker} ${commit}.`
}

export function isPausedSessionMovedError(error: unknown) {
	return (
		error instanceof Error && error.message.includes(pausedSessionMovedMarker)
	)
}

export function readPausedSessionPublish(
	details: Record<string, unknown>,
): PausedSessionPublish | null {
	const session = details['session']
	if (!session || typeof session !== 'object') return null
	const value = session as Record<string, unknown>
	if (typeof value['sessionId'] !== 'string') return null
	return {
		sessionId: value['sessionId'],
		force: value['force'] === true,
		destructiveOverwriteConfirmed:
			value['destructiveOverwriteConfirmed'] === true,
		privateVisibilityChangeConfirmed:
			value['privateVisibilityChangeConfirmed'] === true,
		...(typeof value['expectedPackageScope'] === 'string'
			? { expectedPackageScope: value['expectedPackageScope'] }
			: {}),
	}
}

export function readPausedExternalPublish(
	details: Record<string, unknown>,
): PausedExternalPublish {
	const value = details['externalPublish']
	const options =
		value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
	return {
		allowForce: options['allowForce'] === true,
		destructiveOverwriteConfirmed:
			options['destructiveOverwriteConfirmed'] === true,
	}
}
