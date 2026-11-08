/**
 * The website side of raw RSA signing (ADR 0099): the switch on a signing
 * credential's page and its Raw signatures list. Only the credential's owner
 * (an Owner of the org that holds it), signed in on the website, can turn
 * raw signing on or off. Agents, API tokens, MCP, and packages never can.
 */
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import type { AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	AuthorizationError,
	authorize,
} from '#worker/authorization/authorize.ts'
import {
	credentialResource,
	getOrgCredential,
	missingCredentialResource,
	type OrgCredential,
} from '#worker/credentials/credential-ids.ts'
import {
	listRawSigningEvents,
	readRawSigningSetting,
	setRawSigningEnabled,
	type RawSigningEvent,
	type RawSigningRefusalReason,
} from '#worker/credentials/raw-signing-store.ts'
import {
	orgAuditWriterFromRequest,
	recordOrgAuditEvent,
} from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import type {
	CredentialRawSignatureView,
	CredentialRawSigningView,
} from '#universal/credentials-list.ts'
import { orgResourcePath } from '#universal/org-pages.ts'

const refusalLabels: Record<RawSigningRefusalReason, string> = {
	raw_signing_off: 'Raw signing was off',
	no_access: 'No access to this credential',
	invalid_request: 'The request was not valid',
}

function toSignatureView(event: RawSigningEvent): CredentialRawSignatureView {
	return {
		id: event.id,
		createdAt: event.createdAt,
		who: event.actorUsername,
		via: event.via,
		packageId: event.packageId,
		messageBytes: event.messageBytes,
		signed: event.outcome === 'signed',
		refusal: event.refusalReason ? refusalLabels[event.refusalReason] : null,
	}
}

/** An account or org signing credential; never a package's own key. */
async function isAccountSigningCredential(
	db: D1Database,
	credentialId: string,
) {
	const row = await db
		.prepare(
			`SELECT e.kind AS kind, b.scope AS bucket_scope FROM secret_entries e
			 JOIN secret_buckets b ON b.id = e.bucket_id
			 WHERE e.id = ? AND e.deleted_at IS NULL AND b.deleted_at IS NULL`,
		)
		.bind(credentialId)
		.first<{ kind: string; bucket_scope: string }>()
	return row?.kind === 'signing' && row.bucket_scope === 'user'
}

async function canWrite(
	env: Env,
	request: RequestContext,
	credential: OrgCredential,
) {
	try {
		await authorize(
			{ env, request },
			'secret:write',
			credentialResource(request.org.id, credential),
		)
		return true
	} catch (error) {
		if (error instanceof AuthorizationError) return false
		throw error
	}
}

/** The owner: an Owner of the org holding it, on a website session. */
function isWebsiteOwner(request: RequestContext) {
	return (
		request.credential.kind === 'session' &&
		request.actor !== null &&
		request.membership?.role === 'owner'
	)
}

/**
 * Raw signing for one signing credential on this org's Credentials page. A
 * personal credential seen from a team org links to the owner's own page.
 */
export async function loadCredentialRawSigningView(input: {
	env: Env
	request: RequestContext
	credentialId: string
	/** Set when the credential is the viewer's own, shown from a team org. */
	personalOrgSlug?: string | null
}): Promise<CredentialRawSigningView | null> {
	const { env, request } = input
	const setting = await readRawSigningSetting(env.APP_DB, input.credentialId)
	const signatures = async () =>
		(
			await listRawSigningEvents({
				db: env.APP_DB,
				credentialId: input.credentialId,
			})
		).map(toSignatureView)
	if (input.personalOrgSlug !== undefined) {
		return {
			credentialId: input.credentialId,
			enabled: setting?.enabled ?? false,
			canChange: false,
			manageHref: input.personalOrgSlug
				? orgResourcePath(
						input.personalOrgSlug,
						'credentials',
						encodeURIComponent(input.credentialId),
					)
				: null,
			lastSignedAt: setting?.lastSignedAt ?? null,
			signatures: await signatures(),
		}
	}
	const credential = await getOrgCredential(
		env.APP_DB,
		request.org.id,
		input.credentialId,
	)
	if (!credential?.live || credential.kind !== 'secret') return null
	if (!(await isAccountSigningCredential(env.APP_DB, credential.id))) {
		return null
	}
	const writer =
		request.credential.kind === 'session' &&
		(await canWrite(env, request, credential))
	return {
		credentialId: credential.id,
		enabled: setting?.enabled ?? false,
		canChange: writer && isWebsiteOwner(request),
		manageHref: null,
		lastSignedAt: setting?.lastSignedAt ?? null,
		signatures: writer ? await signatures() : null,
	}
}

export type SetCredentialRawSigningResponse = { ok: true; enabled: boolean }

/** Turns raw signing on or off. The owner on a website session only. */
export async function setCredentialRawSigning(input: {
	env: Env
	user: AuthenticatedAppUser
	credentialId: string
	enabled: boolean
}) {
	const request = input.user.request
	if (request.credential.kind !== 'session' || !request.actor) {
		return operationResult(
			{
				ok: false,
				error:
					'Only the credential owner, signed in on the Kody website, can turn raw signing on or off.',
			},
			403,
		)
	}
	const orgId = ownerIdFromCaller({ request, user: input.user.mcpUser })
	try {
		const credential = await getOrgCredential(
			input.env.APP_DB,
			orgId,
			input.credentialId,
		)
		if (!credential?.live) {
			await authorize(
				{ env: input.env, request },
				'secret:write',
				missingCredentialResource(request.org.id, input.credentialId),
			)
			return operationResult(
				{ ok: false, error: 'Kody could not find that credential here.' },
				404,
			)
		}
		if (
			credential.kind !== 'secret' ||
			!(await isAccountSigningCredential(input.env.APP_DB, credential.id))
		) {
			return operationResult(
				{
					ok: false,
					error:
						'Only account and org signing credentials can sign raw strings.',
				},
				400,
			)
		}
		await authorize(
			{ env: input.env, request },
			'secret:write',
			credentialResource(request.org.id, credential),
		)
		if (!isWebsiteOwner(request)) {
			return operationResult(
				{
					ok: false,
					error:
						'Only an owner of this account or org can turn raw signing on or off.',
				},
				403,
			)
		}
		await setRawSigningEnabled({
			db: input.env.APP_DB,
			credentialId: credential.id,
			orgId,
			enabled: input.enabled,
			userId: request.actor.userId,
		})
		await recordOrgAuditEvent(orgAuditWriterFromRequest(input.env, request), {
			orgId,
			action: input.enabled
				? 'credential.raw_signing_enabled'
				: 'credential.raw_signing_disabled',
			resourceType: 'credential',
			resourceId: credential.id,
			details: { name: credential.name, kind: credential.kind },
		})
		return operationResult({
			ok: true,
			enabled: input.enabled,
		} satisfies SetCredentialRawSigningResponse)
	} catch (error) {
		if (error instanceof AuthorizationError) {
			return operationResult({ ok: false, error: error.message }, 403)
		}
		throw error
	}
}
