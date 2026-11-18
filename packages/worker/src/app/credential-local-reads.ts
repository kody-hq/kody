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
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	connectionLocalReads,
	credentialKindLocalReads,
	packageSecretLocalReads,
	sessionSecretLocalReads,
	type LocalReadsIneligibility,
} from '#universal/credential-local-reads-eligibility.ts'

const refusalLabels: Record<LocalReadRefusalReason, string> = {
	not_found: 'Secret not found',
	no_access: 'No access to this secret',
	local_reads_off: 'Local reads were off',
	token_scope: 'The CLI token could not read secrets locally',
	profile_grant: 'The profile was not allowed to read it locally',
	unsupported_secret: 'Package secrets cannot be read locally',
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

/**
 * Null when an account or org Key, or a vault, can be read locally. A
 * package's own Key, a session Key, and a connection cannot, and say why.
 */
async function localReadsIneligibility(input: {
	db: D1Database
	orgId: string
	orgSlug: string | null
	credential: OrgCredential
}): Promise<LocalReadsIneligibility | null> {
	const { credential } = input
	switch (credential.kind) {
		case 'vault':
			return null
		case 'integration':
		case 'mcp-server':
			return connectionLocalReads(credential.name)
		case 'secret':
			break
		default: {
			const exhaustive: never = credential.kind
			return exhaustive
		}
	}
	const bucket = await input.db
		.prepare(
			`SELECT e.kind AS kind, b.scope AS scope, b.binding_key AS binding_key
			 FROM secret_entries e
			 JOIN secret_buckets b ON b.id = e.bucket_id
			 WHERE e.id = ? AND e.deleted_at IS NULL AND b.deleted_at IS NULL`,
		)
		.bind(credential.id)
		.first<{ kind: string; scope: string; binding_key: string }>()
	if (!bucket) return null
	if (
		bucket.kind === 'url' ||
		bucket.kind === 'login' ||
		bucket.kind === 'signing'
	) {
		return credentialKindLocalReads(credential.name, bucket.kind)
	}
	if (bucket.scope === 'user') return null
	if (bucket.scope !== 'package')
		return sessionSecretLocalReads(credential.name)
	const owner = await getSavedPackageById(input.db, {
		userId: input.orgId,
		packageId: bucket.binding_key,
	})
	return packageSecretLocalReads({
		orgSlug: input.orgSlug,
		name: credential.name,
		packageId: bucket.binding_key,
		packageLabel: owner?.kodyId ?? bucket.binding_key,
	})
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
		await localReadsIneligibility({
			db: env.APP_DB,
			orgId: request.org.id,
			orgSlug: request.org.slug,
			credential,
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
	| {
			ok: false
			message: string
			/** Set when the secret exists but cannot be read locally. */
			name: string | null
			fix: LocalReadsIneligibility['fix']
			detailHref: string | null
	  }

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
		name: null,
		fix: null,
		detailHref: null,
	}
	if (!credential?.live) return missing
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
	const detailHref = orgResourcePath(
		input.orgSlug,
		'credentials',
		encodeURIComponent(credential.id),
	)
	const ineligible = await localReadsIneligibility({
		db: input.env.APP_DB,
		orgId,
		orgSlug: input.orgSlug,
		credential,
	})
	if (ineligible) {
		return {
			ok: false,
			message: ineligible.reason,
			name: credential.name,
			fix: ineligible.fix,
			detailHref,
		}
	}
	const setting = await readLocalReadSetting(input.env.APP_DB, credential.id)
	return {
		ok: true,
		credentialId: credential.id,
		name: credential.name,
		vault: credential.kind === 'vault',
		enabled: setting?.enabled ?? false,
		canChange: await canWrite(input.env, request, credential),
		detailHref,
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
		const ineligible = await localReadsIneligibility({
			db: input.env.APP_DB,
			orgId,
			orgSlug: request.org.slug,
			credential,
		})
		if (ineligible) {
			return operationResult({ ok: false, error: ineligible.reason }, 400)
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
