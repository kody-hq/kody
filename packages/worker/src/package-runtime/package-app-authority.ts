/**
 * Who a package app runs as (ADR 0068 amendment 2026-10-24).
 *
 * Every package app runs as one person in the org that owns it: the runs-as
 * person an owner chose, or else the publisher. That person pays and their
 * credentials are used; visitors only bring their identity. The person is
 * checked live (not deleted or suspended, still a member of the owning org)
 * on every use, with their role there right now, the way triggers act as
 * their enabler. When nobody qualifies, the app fails with an owner-facing
 * message instead of running as nobody.
 */
import {
	personIdFromStored,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	type OrgRole,
	type RequestContext,
} from '@kody-internal/shared/request-context.ts'
import { type RuntimePackageAppVisitor } from '@kody-internal/shared/runtime-worker.ts'
import {
	findLivePackageAppOauthGrant,
	touchPackageAppOauthGrantLastUsed,
} from '#app/package-app-oauth-grants.ts'
import { packageAppVisitorNeedScope } from '#app/package-app-oauth-scopes.ts'
import { type PackageAppCredentialAuthority } from '#worker/credentials/credential-client.ts'
import { isPackageCredentialSuppliersEnabled } from '#worker/credentials/credential-suppliers-flag.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import {
	loadOrgBindingForOrg,
	loadOrgBindingForPerson,
} from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export class PackageAppCapabilityNotDeclaredError extends Error {
	readonly capabilityName: string

	constructor(capabilityName: string) {
		super(
			`Package app capability "${capabilityName}" is not listed in kody.app.capabilities. Apps run as their publisher and may call only the Kody capabilities they declare.`,
		)
		this.name = 'PackageAppCapabilityNotDeclaredError'
		this.capabilityName = capabilityName
	}
}

export class PackageAppCapabilityUnavailableError extends Error {
	constructor(capabilityName: string) {
		super(`Package app capability "${capabilityName}" is not available.`)
		this.name = 'PackageAppCapabilityUnavailableError'
	}
}

export type PackageAppAuthorityScope = {
	/** The org that owns the app. */
	orgId: OwnerId
	/** The app package. */
	packageId: string
}

/** Where the runs-as person came from. */
export type PackageAppRunsAsSource = 'explicit' | 'publisher' | 'personal-org'

export type PackageAppRunsAs =
	| {
			status: 'ready'
			personId: PersonId
			source: PackageAppRunsAsSource
			role: OrgRole
			email: string
			username: string
			displayName: string
			/** The runs-as person in the owning org, as a package-app credential. */
			request: RequestContext
	  }
	| {
			status: 'unavailable'
			reason: 'not-set' | 'person-unavailable'
			message: string
	  }

export const packageAppRunsAsUnavailableMessages = {
	'not-set':
		'This app has no one to run as. An owner of its org must publish it again or choose who it runs as.',
	'person-unavailable':
		'This app runs as a person who can no longer act for its org. An owner of its org must choose who it runs as.',
	'lookup-failed': 'Kody could not check who this app runs as. Try again.',
} as const

export type PackageAppRunsAsUnavailableReason =
	keyof typeof packageAppRunsAsUnavailableMessages

export class PackageAppRunsAsUnavailableError extends Error {
	readonly reason: PackageAppRunsAsUnavailableReason

	constructor(
		reason: PackageAppRunsAsUnavailableReason,
		options?: ErrorOptions,
	) {
		super(packageAppRunsAsUnavailableMessages[reason], options)
		this.name = 'PackageAppRunsAsUnavailableError'
		this.reason = reason
	}
}

/** Answers with the visitor's identity, never the runs-as person's. */
export const packageAppIdentityCapabilityName = 'metaGetCurrentUser'

/** `kody.visitorNeed({ need, args })`: a consented call on the visitor's data. */
export const packageAppVisitorNeedCallName = 'visitorNeed'

/**
 * A visitor-data call without a live grant covering its need. Never retried
 * as the runs-as person: that would hand the publisher's data to an app that
 * asked for the visitor's.
 */
export class PackageAppVisitorConsentError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PackageAppVisitorConsentError'
	}
}

/**
 * Seconds, not minutes: a removed or suspended runs-as person stops acting
 * for the app within this window.
 */
export const packageAppRunsAsCacheTtlMs = 5_000

const runsAsCache = new PromiseLruCache<PackageAppRunsAs>({
	ttlMs: packageAppRunsAsCacheTtlMs,
	limit: 500,
})

function cacheKey(scope: PackageAppAuthorityScope) {
	return JSON.stringify([scope.orgId, scope.packageId])
}

export function forgetPackageAppRunsAs(scope: PackageAppAuthorityScope) {
	runsAsCache.delete(cacheKey(scope))
}

export async function loadPackageAppRunsAs(input: {
	env: Pick<Env, 'APP_DB'>
	scope: PackageAppAuthorityScope
}): Promise<PackageAppRunsAs> {
	return await runsAsCache.getOrCreate({
		cacheKey: cacheKey(input.scope),
		create: () => resolveRunsAs(input.env.APP_DB, input.scope),
	})
}

type Candidate = { personId: string; source: PackageAppRunsAsSource }

async function resolveCandidate(
	db: D1Database,
	scope: PackageAppAuthorityScope,
): Promise<Candidate | null> {
	const row = await db
		.prepare(
			`SELECT runs_as_person_id, published_by_person_id, publisher_unknown
			 FROM package_app_authority
			 WHERE package_id = ? AND owner_id = ?`,
		)
		.bind(scope.packageId, scope.orgId)
		.first<{
			runs_as_person_id: string | null
			published_by_person_id: string | null
			publisher_unknown: number | null
		}>()
	const explicit = row?.runs_as_person_id?.trim()
	if (explicit) return { personId: explicit, source: 'explicit' }
	if (row?.publisher_unknown === 1) return null
	const publisher = row?.published_by_person_id?.trim()
	if (publisher) return { personId: publisher, source: 'publisher' }
	const personal = await db
		.prepare(
			`SELECT stable_user_id FROM users
			 WHERE (personal_org_id = ? OR stable_user_id = ?)${andLiveDeletedAtSql()}
			 LIMIT 1`,
		)
		.bind(scope.orgId, scope.orgId)
		.first<{ stable_user_id: string }>()
	if (personal?.stable_user_id) {
		return { personId: personal.stable_user_id, source: 'personal-org' }
	}
	return null
}

async function resolveRunsAs(
	db: D1Database,
	scope: PackageAppAuthorityScope,
): Promise<PackageAppRunsAs> {
	const candidate = await resolveCandidate(db, scope)
	if (!candidate) {
		return {
			status: 'unavailable',
			reason: 'not-set',
			message: packageAppRunsAsUnavailableMessages['not-set'],
		}
	}
	const person = await db
		.prepare(
			`SELECT stable_user_id, username, email, display_name FROM users
			 WHERE stable_user_id = ?
			   AND suspended_at IS NULL
			   AND deleting_at IS NULL${andLiveDeletedAtSql()}
			 LIMIT 1`,
		)
		.bind(candidate.personId)
		.first<{
			stable_user_id: string
			username: string | null
			email: string | null
			display_name: string | null
		}>()
	const binding = person
		? await loadOrgBindingForOrg(db, person.stable_user_id, scope.orgId)
		: null
	if (!person || !binding?.role) {
		return {
			status: 'unavailable',
			reason: 'person-unavailable',
			message: packageAppRunsAsUnavailableMessages['person-unavailable'],
		}
	}
	const personId = personIdFromStored(person.stable_user_id)
	const username = person.username ?? ''
	return {
		status: 'ready',
		personId,
		source: candidate.source,
		role: binding.role,
		email: person.email ?? '',
		username,
		displayName: person.display_name?.trim() || username,
		request: deriveRequestContext({
			user: { userId: personId, username: username || undefined },
			source: { kind: 'package-app' },
			orgBinding: binding,
		}),
	}
}

/**
 * Record who published an app package, so it runs as them by default. A
 * publisher who is not an owner clears an explicit runs-as person other than
 * themselves: otherwise their new code would act with that person's
 * authority.
 */
export async function recordPackageAppPublisher(input: {
	db: D1Database
	scope: PackageAppAuthorityScope
	personId: string
	publisherIsOwner: boolean
	now?: Date
}) {
	const personId = input.personId.trim()
	if (!personId) return
	await input.db
		.prepare(
			`INSERT INTO package_app_authority
			 (package_id, owner_id, published_by_person_id, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(package_id) DO UPDATE SET
				owner_id = excluded.owner_id,
				published_by_person_id = excluded.published_by_person_id,
				publisher_unknown = 0,
				runs_as_person_id = CASE
					WHEN ? = 1 THEN package_app_authority.runs_as_person_id
					WHEN package_app_authority.runs_as_person_id = excluded.published_by_person_id
						THEN package_app_authority.runs_as_person_id
					ELSE NULL
				END,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.scope.packageId,
			input.scope.orgId,
			personId,
			(input.now ?? new Date()).toISOString(),
			input.publisherIsOwner ? 1 : 0,
		)
		.run()
	forgetPackageAppRunsAs(input.scope)
}

/**
 * Someone published without a known person: forget the publisher and any
 * explicit runs-as person so the new code never runs as them. The app fails
 * closed until a known person publishes or an owner picks someone.
 */
export async function recordPackageAppPublisherUnknown(input: {
	db: D1Database
	scope: PackageAppAuthorityScope
	now?: Date
}) {
	await input.db
		.prepare(
			`INSERT INTO package_app_authority
			 (package_id, owner_id, publisher_unknown, updated_at)
			 VALUES (?, ?, 1, ?)
			 ON CONFLICT(package_id) DO UPDATE SET
				owner_id = excluded.owner_id,
				published_by_person_id = NULL,
				runs_as_person_id = NULL,
				publisher_unknown = 1,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.scope.packageId,
			input.scope.orgId,
			(input.now ?? new Date()).toISOString(),
		)
		.run()
	forgetPackageAppRunsAs(input.scope)
}

/**
 * Record the person behind a publish (null: no known person). Call before the
 * new code serves, so it never runs as someone the publisher could not act as.
 */
export async function recordPackageAppPublish(input: {
	db: D1Database
	scope: PackageAppAuthorityScope
	personId: string | null
}) {
	if (input.personId === null) {
		await recordPackageAppPublisherUnknown({ db: input.db, scope: input.scope })
		return
	}
	const binding = await loadOrgBindingForOrg(
		input.db,
		input.personId,
		input.scope.orgId,
	)
	await recordPackageAppPublisher({
		db: input.db,
		scope: input.scope,
		personId: input.personId,
		publisherIsOwner: binding?.role === 'owner',
	})
}

/** Choose who an app runs as; null goes back to the publisher. */
export async function setPackageAppRunsAsPerson(input: {
	db: D1Database
	scope: PackageAppAuthorityScope
	personId: string | null
	now?: Date
}) {
	await input.db
		.prepare(
			`INSERT INTO package_app_authority
			 (package_id, owner_id, runs_as_person_id, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(package_id) DO UPDATE SET
				owner_id = excluded.owner_id,
				runs_as_person_id = excluded.runs_as_person_id,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.scope.packageId,
			input.scope.orgId,
			input.personId?.trim() || null,
			(input.now ?? new Date()).toISOString(),
		)
		.run()
	forgetPackageAppRunsAs(input.scope)
}

/** The Sign in with Kody grant a visitor gave this app, read live. */
export type PackageAppVisitorGrantScope = {
	/** The owning org's slug, as grants record it. */
	orgSlug: string
	kodyId: string
}

/**
 * True while the visitor's live grant for this app covers `needKey`. A
 * revoke takes effect on the next call. Marks the grant used.
 */
export async function packageAppVisitorConsents(input: {
	db: D1Database
	visitorPersonId: string | null | undefined
	grantScope: PackageAppVisitorGrantScope | null | undefined
	needKey: string
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<boolean> {
	const personId = input.visitorPersonId?.trim()
	const grantScope = input.grantScope
	if (!personId || !grantScope?.orgSlug || !grantScope.kodyId) return false
	const grant = await findLivePackageAppOauthGrant({
		db: input.db,
		personId,
		orgUsername: grantScope.orgSlug.toLowerCase(),
		kodyId: grantScope.kodyId,
	})
	if (!grant?.scopes.includes(packageAppVisitorNeedScope(input.needKey))) {
		return false
	}
	const touched = touchPackageAppOauthGrantLastUsed({
		db: input.db,
		grantId: grant.id,
	}).catch((error: unknown) => {
		console.warn('package-app-grant-last-used-failed', error)
	})
	if (input.waitUntil) input.waitUntil(touched)
	else await touched
	return true
}

/**
 * Who a package app's credential handles resolve as on each use: a `runsAs`
 * handle as the live runs-as person, a `visitorNeed` handle as the visitor
 * while their consent covers that need.
 */
export function createPackageAppCredentialAuthority(input: {
	env: Pick<Env, 'APP_DB'>
	scope: PackageAppAuthorityScope
	grantScope: PackageAppVisitorGrantScope | null
	visitorRequest: RequestContext | null
	issue: PackageAppCredentialAuthority['issue']
	waitUntil?: (promise: Promise<unknown>) => void
}): PackageAppCredentialAuthority {
	return {
		issue: input.issue,
		orgId: input.scope.orgId,
		runsAsRequest: async () => {
			const runsAs = await loadPackageAppRunsAs({
				env: input.env,
				scope: input.scope,
			})
			return runsAs.status === 'ready' ? runsAs.request : null
		},
		visitorNeedRequest: async (needKey) => {
			const grant = await visitorNeedGrant(needKey)
			return grant?.request ?? null
		},
		visitorNeedGrant: async (needKey) => await visitorNeedGrant(needKey),
	}

	async function visitorNeedGrant(needKey: string) {
		const visitor = input.visitorRequest
		if (
			!visitor?.actor ||
			!input.grantScope?.orgSlug ||
			!input.grantScope.kodyId
		) {
			return null
		}
		const grant = await findLivePackageAppOauthGrant({
			db: input.env.APP_DB,
			personId: visitor.actor.userId,
			orgUsername: input.grantScope.orgSlug.toLowerCase(),
			kodyId: input.grantScope.kodyId,
		})
		if (!grant?.scopes.includes(packageAppVisitorNeedScope(needKey))) {
			return null
		}
		const touched = touchPackageAppOauthGrantLastUsed({
			db: input.env.APP_DB,
			grantId: grant.id,
		}).catch((error: unknown) => {
			console.warn('package-app-grant-last-used-failed', error)
		})
		if (input.waitUntil) input.waitUntil(touched)
		else await touched
		return { request: visitor, grantId: grant.id }
	}
}

export async function createPackageAppVisitorPersonalRequest(input: {
	db: D1Database
	visitor: Pick<RuntimePackageAppVisitor, 'userId' | 'username'> | null
}) {
	const visitor = input.visitor
	if (!visitor) return null
	const orgBinding = await loadOrgBindingForPerson(input.db, visitor.userId)
	return deriveRequestContext({
		user: { userId: visitor.userId, username: visitor.username },
		source: { kind: 'package-app' },
		orgBinding,
	})
}

export async function createPackageAppVisitorCredentialRequest(input: {
	db: D1Database
	orgId: OwnerId
	callerRequest: RequestContext | null
	visitor: Pick<RuntimePackageAppVisitor, 'userId' | 'username'> | null
}) {
	const suppliersEnabled = await isPackageCredentialSuppliersEnabled({
		db: input.db,
		orgId: input.orgId,
		request: input.callerRequest,
	})
	if (!suppliersEnabled) return input.callerRequest
	return await createPackageAppVisitorPersonalRequest({
		db: input.db,
		visitor: input.visitor,
	})
}
