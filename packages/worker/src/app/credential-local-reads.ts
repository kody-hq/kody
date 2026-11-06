/**
 * The website side of local reads (ADR 0097): the switch on a secret's page,
 * the one-step page a refused CLI read links to, and the Local reads list.
 * Only a person signed in on the website can turn local reads on or off.
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
	listLocalReadEvents,
	readLocalReadSetting,
	setLocalReadEnabled,
	type LocalReadEvent,
	type LocalReadRefusalReason,
} from '#worker/credentials/local-read-store.ts'
import {
	orgAuditWriterFromRequest,
	recordOrgAuditEvent,
} from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import type {
	CredentialLocalReadView,
	CredentialLocalReadsView,
} from '#universal/credentials-list.ts'
import { orgResourcePath } from '#universal/org-pages.ts'

const refusalLabels: Record<LocalReadRefusalReason, string> = {
	not_found: 'Secret not found',
	no_access: 'No access to this secret',
	local_reads_off: 'Local reads were off',
	token_scope: 'The CLI token could not read secrets locally',
	profile_grant: 'The profile was not allowed to read it locally',
	unsupported_secret: 'This kind of secret cannot be read locally',
	rate_limited: 'Too many reads in a minute',
	provider_failed: 'The secret provider could not be reached',
	other_secret_refused: 'Another secret in the same command was refused',
}

function toReadView(event: LocalReadEvent): CredentialLocalReadView {
	return {
		id: event.id,
		createdAt: event.createdAt,
		who: event.actorUsername,
		device:
			event.tokenName === 'kody-cli'
				? 'Kody CLI (unnamed device)'
				: event.tokenName,
		profile: event.profileName,
		command: event.command,
		ip: event.ip,
		allowed: event.outcome === 'allowed',
		refusal: event.refusalReason ? refusalLabels[event.refusalReason] : null,
	}
}

/** Account and org Keys and vaults; never a package's own Key. */
export function credentialSupportsLocalReads(input: {
	kind: OrgCredential['kind']
	packageOwned: boolean
}) {
	if (input.packageOwned) return false
	return input.kind === 'secret' || input.kind === 'vault'
}

async function canWrite(
	env: Env,
	request: RequestContext,
	credential: OrgCredential,
) {
	if (request.credential.kind !== 'session') return false
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

async function isPackageOwnedKey(db: D1Database, credentialId: string) {
	const row = await db
		.prepare(
			`SELECT b.scope AS bucket_scope FROM secret_entries e
			 JOIN secret_buckets b ON b.id = e.bucket_id
			 WHERE e.id = ?`,
		)
		.bind(credentialId)
		.first<{ bucket_scope: string }>()
	return row ? row.bucket_scope !== 'user' : false
}

/**
 * Local reads for one credential on this org's Credentials page. A personal
 * credential seen from a team org links to the owner's own page to change it.
 */
export async function loadCredentialLocalReadsView(input: {
	env: Env
	request: RequestContext
	credentialId: string
	/** Set when the credential is the viewer's own, shown from a team org. */
	personalOrgSlug?: string | null
}): Promise<CredentialLocalReadsView | null> {
	const { env, request } = input
	const setting = await readLocalReadSetting(env.APP_DB, input.credentialId)
	const own = input.personalOrgSlug !== undefined
	if (own) {
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
			lastReadAt: setting?.lastReadAt ?? null,
			reads: (
				await listLocalReadEvents({
					db: env.APP_DB,
					credentialId: input.credentialId,
				})
			).map(toReadView),
		}
	}
	const credential = await getOrgCredential(
		env.APP_DB,
		request.org.id,
		input.credentialId,
	)
	if (!credential?.live) return null
	if (
		!credentialSupportsLocalReads({
			kind: credential.kind,
			packageOwned:
				credential.kind === 'secret' &&
				(await isPackageOwnedKey(env.APP_DB, credential.id)),
		})
	) {
		return null
	}
	const writer = await canWrite(env, request, credential)
	return {
		credentialId: credential.id,
		enabled: setting?.enabled ?? false,
		canChange: writer,
		manageHref: null,
		lastReadAt: setting?.lastReadAt ?? null,
		reads: writer
			? (
					await listLocalReadEvents({
						db: env.APP_DB,
						credentialId: credential.id,
					})
				).map(toReadView)
			: null,
	}
}

export type LocalReadsApproval =
	| {
			ok: true
			credentialId: string
			name: string
			vault: boolean
			enabled: boolean
			canChange: boolean
			detailHref: string
	  }
	| { ok: false; message: string }

/** The one-step page: what it would turn on. Loading it never changes anything. */
export async function loadLocalReadsApproval(input: {
	env: Env
	user: AuthenticatedAppUser
	orgSlug: string
	credentialId: string
}): Promise<LocalReadsApproval> {
	const request = input.user.request
	const orgId = ownerIdFromCaller({ request, user: input.user.mcpUser })
	const credential = await getOrgCredential(
		input.env.APP_DB,
		orgId,
		input.credentialId,
	)
	const missing = {
		ok: false as const,
		message:
			'Kody could not find that secret here. It may have been deleted, or it belongs to a different account or org.',
	}
	if (!credential?.live) return missing
	if (
		!credentialSupportsLocalReads({
			kind: credential.kind,
			packageOwned:
				credential.kind === 'secret' &&
				(await isPackageOwnedKey(input.env.APP_DB, credential.id)),
		})
	) {
		return {
			ok: false,
			message: 'Only account and org secrets can be read locally.',
		}
	}
	try {
		await authorize(
			{ env: input.env, request },
			'secret:use',
			credentialResource(request.org.id, credential),
		)
	} catch (error) {
		if (error instanceof AuthorizationError) return missing
		throw error
	}
	const setting = await readLocalReadSetting(input.env.APP_DB, credential.id)
	return {
		ok: true,
		credentialId: credential.id,
		name: credential.name,
		vault: credential.kind === 'vault',
		enabled: setting?.enabled ?? false,
		canChange: await canWrite(input.env, request, credential),
		detailHref: orgResourcePath(
			input.orgSlug,
			'credentials',
			encodeURIComponent(credential.id),
		),
	}
}

export type SetCredentialLocalReadsResponse = { ok: true; enabled: boolean }

/** Turns local reads on or off. A website session with write access only. */
export async function setCredentialLocalReads(input: {
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
					'Only a person signed in on the Kody website can turn local reads on or off.',
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
				{ ok: false, error: 'Kody could not find that secret here.' },
				404,
			)
		}
		if (
			!credentialSupportsLocalReads({
				kind: credential.kind,
				packageOwned:
					credential.kind === 'secret' &&
					(await isPackageOwnedKey(input.env.APP_DB, credential.id)),
			})
		) {
			return operationResult(
				{
					ok: false,
					error: 'Only account and org secrets can be read locally.',
				},
				400,
			)
		}
		await authorize(
			{ env: input.env, request },
			'secret:write',
			credentialResource(request.org.id, credential),
		)
		await setLocalReadEnabled({
			db: input.env.APP_DB,
			credentialId: credential.id,
			orgId,
			enabled: input.enabled,
			userId: request.actor.userId,
		})
		await recordOrgAuditEvent(orgAuditWriterFromRequest(input.env, request), {
			orgId,
			action: input.enabled
				? 'credential.local_reads_enabled'
				: 'credential.local_reads_disabled',
			resourceType: 'credential',
			resourceId: credential.id,
			details: { name: credential.name, kind: credential.kind },
		})
		return operationResult({
			ok: true,
			enabled: input.enabled,
		} satisfies SetCredentialLocalReadsResponse)
	} catch (error) {
		if (error instanceof AuthorizationError) {
			return operationResult({ ok: false, error: error.message }, 403)
		}
		throw error
	}
}
