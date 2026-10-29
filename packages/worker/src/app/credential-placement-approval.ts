/**
 * Owner approval of a credential placement request from `/connect/secrets`
 * (`placement=query,path,body`). Approving widens the stored placement to the
 * requested parts and records the owner opt-in for exactly those parts (plus
 * the ones already opted in), in the same audited batch. Only the website
 * calls this; agents can only build the link.
 */
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { normalizeBulkPackageSecretApprovalNames } from '#mcp/secrets/package-approval-url.ts'
import {
	AuthorizationError,
	authorize,
} from '#worker/authorization/authorize.ts'
import {
	readStoredCredentialPlacement,
	updateCredentialFields,
} from '#worker/credentials/credential-fields.ts'
import {
	credentialPermissionFamily,
	credentialResource,
	getOrgCredential,
} from '#worker/credentials/credential-ids.ts'
import { effectiveFillPlacement } from '#worker/credentials/fill-placement-enforcement.ts'
import {
	type FillPlacementOptIn,
	readFillPlacementOptIn,
} from '#worker/credentials/fill-placement-opt-ins.ts'
import { type CredentialFillPlacement } from '#worker/credentials/fill-placement.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	type CredentialPlacementApprovalView,
	normalizePlacementApprovalParts,
	type PlacementApprovalPart,
} from '#universal/credential-placement-approval.ts'

export type CredentialPlacementApprovalPlan = {
	/** Requested parts the credential cannot fill yet. */
	pendingParts: Array<PlacementApprovalPart>
	placement: CredentialFillPlacement
	optIn: FillPlacementOptIn
}

/**
 * The placement and opt-in after approving `parts`. A legacy (null)
 * placement becomes explicit: what it already fills, plus `parts`. Parts the
 * stored placement lists but the owner never opted in stay un-opted.
 */
export function planCredentialPlacementApproval(input: {
	stored: CredentialFillPlacement | null
	optIn: FillPlacementOptIn
	parts: ReadonlyArray<PlacementApprovalPart>
}): CredentialPlacementApprovalPlan {
	const effective = effectiveFillPlacement(input.stored, input.optIn) ?? {}
	const pendingParts = input.parts.filter((part) => effective[part] !== true)
	const base: CredentialFillPlacement =
		input.stored === null ? { ...effective } : { ...input.stored }
	const placement: CredentialFillPlacement = { ...base }
	const optIn: FillPlacementOptIn = { ...input.optIn }
	for (const part of input.parts) {
		placement[part] = true
		optIn[part] = true
	}
	return { pendingParts, placement, optIn }
}

function requestedNames(names: ReadonlyArray<string>) {
	return normalizeBulkPackageSecretApprovalNames(
		names.flatMap((value) => value.split(',')),
	)
}

const pinnedCredentialMismatch =
	'This link was made for a different credential than the one saved under that name here. Open the link from the original error again, or ask for a new link.'

/**
 * A pinned link must name one credential, and that name must resolve to the
 * pinned credential in this org. Never falls back to a same-named one.
 */
function pinnedCredentialError(input: {
	credentialId: string | null | undefined
	names: ReadonlyArray<string>
	storedId: string | null
}) {
	if (!input.credentialId) return null
	if (input.names.length !== 1) return pinnedCredentialMismatch
	return input.storedId === input.credentialId ? null : pinnedCredentialMismatch
}

/**
 * Null when every name resolves to the pinned credential in the viewer's org,
 * or nothing is pinned. Guards the host approval that rides on a pinned link.
 */
export async function pinnedCredentialMismatchFor(input: {
	env: Env
	user: AuthenticatedAppUser
	names: ReadonlyArray<string>
	credentialId: string | null | undefined
	/** Where the host update writes; pinned ids only name org-scope credentials. */
	target?: { scope: string; storagePackageId?: string; sessionId?: string }
}): Promise<string | null> {
	if (!input.credentialId) return null
	const names = requestedNames(input.names)
	if (names.length !== 1) return pinnedCredentialMismatch
	const target = input.target
	if (
		target &&
		(target.scope !== 'user' ||
			target.storagePackageId?.trim() ||
			target.sessionId?.trim())
	) {
		return pinnedCredentialMismatch
	}
	const orgId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	const stored = await readStoredCredentialPlacement({
		db: input.env.APP_DB,
		orgId,
		name: names[0]!,
	})
	return pinnedCredentialError({
		credentialId: input.credentialId,
		names,
		storedId: stored?.id ?? null,
	})
}

/** What the approval page shows. Never reads a credential value. */
export async function loadCredentialPlacementApprovalView(input: {
	env: Env
	user: AuthenticatedAppUser
	names: ReadonlyArray<string>
	parts: ReadonlyArray<string>
	/** The exact credential the link was made for, when pinned. */
	credentialId?: string | null
}): Promise<CredentialPlacementApprovalView | null> {
	const parts = normalizePlacementApprovalParts(input.parts)
	const names = requestedNames(input.names)
	if (parts.length === 0 || names.length === 0) return null
	const orgId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	const view: CredentialPlacementApprovalView = {
		parts,
		credentials: [],
		missingNames: [],
	}
	for (const name of names) {
		const stored = await readStoredCredentialPlacement({
			db: input.env.APP_DB,
			orgId,
			name,
		})
		const pinned = pinnedCredentialError({
			credentialId: input.credentialId,
			names,
			storedId: stored?.id ?? null,
		})
		if (pinned) throw new McpCallerError(pinned)
		if (!stored) {
			view.missingNames.push(name)
			continue
		}
		const optIn = await readFillPlacementOptIn(input.env.APP_DB, stored.id)
		const plan = planCredentialPlacementApproval({
			stored: stored.placement,
			optIn,
			parts,
		})
		view.credentials.push({
			name,
			placement: stored.placement,
			pendingParts: plan.pendingParts,
			placementAfter: plan.pendingParts.length > 0 ? plan.placement : null,
		})
	}
	return view
}

export type ApproveCredentialPlacementResponse = {
	ok: true
	approved: Array<string>
	alreadyAllowed: Array<string>
}

export async function approveCredentialPlacement(input: {
	env: Env
	user: AuthenticatedAppUser
	names: ReadonlyArray<string>
	parts: ReadonlyArray<string>
	/** The exact credential the link was made for, when pinned. */
	credentialId?: string | null
}) {
	const parts = normalizePlacementApprovalParts(input.parts)
	const names = requestedNames(input.names)
	if (parts.length === 0) {
		return operationResult(
			{
				ok: false,
				error: 'Choose a placement to allow: query, path, or body.',
			},
			400,
		)
	}
	if (names.length === 0) {
		return operationResult(
			{ ok: false, error: 'A credential name is required.' },
			400,
		)
	}
	const request = input.user.request
	const orgId = ownerIdFromCaller({ request, user: input.user.mcpUser })
	const db = input.env.APP_DB
	try {
		const plans: Array<{
			name: string
			credentialId: string
			plan: CredentialPlacementApprovalPlan
		}> = []
		for (const name of names) {
			const stored = await readStoredCredentialPlacement({ db, orgId, name })
			const pinned = pinnedCredentialError({
				credentialId: input.credentialId,
				names,
				storedId: stored?.id ?? null,
			})
			if (pinned) return operationResult({ ok: false, error: pinned }, 409)
			const credential = stored
				? await getOrgCredential(db, orgId, stored.id)
				: null
			if (!stored || !credential?.live) {
				return operationResult(
					{ ok: false, error: `No credential named "${name}" in this org.` },
					404,
				)
			}
			await authorize(
				{ env: input.env, request },
				`${credentialPermissionFamily(credential.kind)}:write`,
				credentialResource(request.org.id, credential),
			)
			const optIn = await readFillPlacementOptIn(db, credential.id)
			plans.push({
				name,
				credentialId: credential.id,
				plan: planCredentialPlacementApproval({
					stored: stored.placement,
					optIn,
					parts,
				}),
			})
		}
		const approved: Array<string> = []
		const alreadyAllowed: Array<string> = []
		for (const entry of plans) {
			if (entry.plan.pendingParts.length === 0) {
				alreadyAllowed.push(entry.name)
				continue
			}
			await updateCredentialFields({
				db,
				orgId,
				credentialId: entry.credentialId,
				update: { placement: entry.plan.placement },
				audit: orgAuditWriterFromRequest(input.env, request),
				ownerOptIn: entry.plan.optIn,
			})
			approved.push(entry.name)
		}
		return operationResult({
			ok: true,
			approved,
			alreadyAllowed,
		} satisfies ApproveCredentialPlacementResponse)
	} catch (error) {
		if (error instanceof AuthorizationError) {
			return operationResult({ ok: false, error: error.message }, 403)
		}
		if (error instanceof McpCallerError) {
			return operationResult({ ok: false, error: error.message }, 400)
		}
		throw error
	}
}

/** The loader fields for `/connect/secrets?placement=`; errors stay on the page. */
export async function loadPlacementApproval(
	input: Parameters<typeof loadCredentialPlacementApprovalView>[0],
): Promise<{
	placementApproval: CredentialPlacementApprovalView | null
	placementApprovalError: string | null
} | null> {
	if (normalizePlacementApprovalParts(input.parts).length === 0) return null
	if (requestedNames(input.names).length === 0) {
		return {
			placementApproval: null,
			placementApprovalError:
				'This placement request names no credential. Copy the approval link again.',
		}
	}
	try {
		return {
			placementApproval: await loadCredentialPlacementApprovalView(input),
			placementApprovalError: null,
		}
	} catch (error) {
		return {
			placementApproval: null,
			placementApprovalError:
				error instanceof Error
					? error.message
					: 'Unable to read this placement request.',
		}
	}
}
