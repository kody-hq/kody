/**
 * The one door for using an org credential: `resolveCredential`.
 *
 * Every runtime site that turns a credential reference into usable material
 * calls this function, and credential storage (secret values, OAuth tokens,
 * vault door keys, MCP hub tool calls) is read nowhere else but the door and
 * its resolvers (`credential-storage-boundary.node.test.ts` enforces that).
 * Each call:
 *
 * 1. checks that the acting person still has access to the org (live
 *    membership, team, or outside-collaborator grant, org not deleted or
 *    suspended), so access that ended without a cascade cannot resolve;
 * 2. asks the credential kind's resolver (`credential-resolver.ts`) to find
 *    the credential by metadata, with no decrypt;
 * 3. authorizes the use: the actor's Use on the credential's stable id,
 *    whatever the package stamp, then the package rules (secret allowlists,
 *    integration and MCP usage modes, vault provider grants) and, where the
 *    metadata has them, allowed hosts. A renamed credential keeps its grants
 *    and a deleted then recreated name starts with none. A trigger acts as its
 *    enabler, so it needs the enabler's own Use, and a denial pauses that
 *    enablement;
 * 4. only then applies the credential, the one step that reads storage;
 * 5. schedules a `credential.resolve` org audit row for every outcome
 *    (success, not found, denied, failed), for every kind of actor. A
 *    fetch-gateway fill passes the placements it filled or refused; each
 *    placement is its own row (lowercase header name, or `url` / `body`) and
 *    the credential is still read once. A later placement of a credential
 *    this request already resolved records another row without reading it
 *    again. The row never holds the credential value. A later MCP tool call
 *    is not part of that row: each `callTool` on the connection handle writes
 *    its own `mcp.call` row (tool name, connection, success or failure, error
 *    class, duration) and never the arguments or return value.
 *
 * A request with no acting person holds no permissions. The only path with
 * no request at all is webhook ingress verifying a signature, which passes an
 * attested package stamp.
 */
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { pauseEnablementOnDenial } from '#worker/enablements/pause-on-denial.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { assertContextGrantAllowsCredential } from './context-credential-grant.ts'
import { enablementIdOf } from '#worker/request-context/request-context.ts'
import {
	credentialResolutionOutcomeForError,
	scheduleCredentialResolutionAudit,
	type CredentialAuditSubject,
	type CredentialResolutionOutcome,
} from './credential-resolution-audit.ts'
import {
	clientKeyResolver,
	clientOauthRefreshResolver,
	clientOauthResolver,
} from './client-resolver.ts'
import {
	credentialFetchPlacementKey,
	permissionForUse,
	type CredentialFetchPlacement,
	type CredentialResolver,
	type CredentialTarget,
	type CredentialTargetFor,
	type CredentialUse,
	type ResolveCredentialInput,
	type ResolvedCredential,
} from './credential-resolver.ts'
import {
	readFetchFillPlacement,
	readFetchFillPlacementCredentialId,
	readFetchFillPlacementRefusalLinks,
} from './fetch-fill-placement-cache.ts'
import { enforceFillPlacement } from './fill-placement-enforcement.ts'
import { type CredentialFillSite } from './fill-placement.ts'
import { loginCredentialResolver } from './login-resolver.ts'
import { mcpConnectionResolver } from './mcp-resolver.ts'
import {
	integrationRefreshResolver,
	integrationTokenResolver,
} from './oauth-resolvers.ts'
import {
	packageSecretMountResolver,
	secretResolver,
	vaultSecretResolver,
	webhookSecretResolver,
} from './secret-resolvers.ts'
import { type PackageStamp } from './package-stamp.ts'
import { assertSelfPublishedPackageResolvesNothing } from './self-published-package-guard.ts'
import {
	assertCredentialUsesDeclared,
	type CredentialNeedReference,
} from './credential-need-enforcement.ts'
import { signingCredentialResolver } from './signing-resolver.ts'
import { urlCredentialResolver } from './url-resolver.ts'

const credentialResolvers: {
	[U in CredentialUse]: CredentialResolver<U>
} = {
	secret: secretResolver,
	'package-secret-mount': packageSecretMountResolver,
	'webhook-secret': webhookSecretResolver,
	'provider-secret': vaultSecretResolver,
	'integration-token': integrationTokenResolver,
	'integration-refresh': integrationRefreshResolver,
	'mcp-connection': mcpConnectionResolver,
	url: urlCredentialResolver,
	login: loginCredentialResolver,
	signing: signingCredentialResolver,
	'client-key': clientKeyResolver,
	'client-oauth': clientOauthResolver,
	'client-oauth-refresh': clientOauthRefreshResolver,
}

export async function resolveCredential<T extends CredentialTarget>(
	input: ResolveCredentialInput<T>,
): Promise<ResolvedCredential<T>> {
	return await resolveWith(
		credentialResolvers[input.credential.use] as CredentialResolver<T['use']>,
		input,
	)
}

/**
 * Name-based uses a credential stamp seals. These stay off this door:
 * webhook enablement secret and integration names (not stamp keys), id-based
 * client uses (already checked as `credential(key)`), `package-secret-mount`
 * (the resolver checks the loaded mount name, not the alias), `mcp-connection`
 * (the synthesized server capability checks `ref.name`; the client already
 * checked the key), and `integration-refresh` (webhook 401 retry shares this
 * use; `integrationTokenRefresh` checks the name in its handler).
 */
function credentialUseNeedReference(
	credential: CredentialTarget,
): CredentialNeedReference | null {
	switch (credential.use) {
		case 'secret':
			return {
				use: 'secret',
				name: credential.name,
				scope: credential.scope ?? null,
			}
		case 'provider-secret':
			return { use: 'provider', provider: credential.provider }
		case 'webhook-secret':
		case 'integration-token':
		case 'integration-refresh':
		case 'mcp-connection':
		case 'package-secret-mount':
		case 'url':
		case 'login':
		case 'signing':
		case 'client-key':
		case 'client-oauth':
		case 'client-oauth-refresh':
			return null
		default: {
			const exhaustive: never = credential
			throw new Error(`Unhandled credential use: ${String(exhaustive)}`)
		}
	}
}

async function resolveWith<U extends CredentialUse>(
	resolver: CredentialResolver<U>,
	input: ResolveCredentialInput<CredentialTarget>,
) {
	const credential = input.credential as CredentialTargetFor<U>
	// A bad placement is a caller bug. Fail before any credential read, and
	// before the audit copy, so a thrown label cannot hide a finished read.
	for (const placement of fetchPlacementsOf(credential) ?? []) {
		credentialFetchPlacementKey(placement)
	}
	const subject = resolver.auditSubject(credential)
	const audit = (outcome: CredentialResolutionOutcome) => {
		const subjects = auditSubjectFor(subject, credential)
		for (const row of subjects) {
			scheduleCredentialResolutionAudit({
				env: input.env,
				orgId: input.orgId,
				actor: input.actor,
				packageStamp: input.packageStamp,
				subject: row,
				outcome,
				details: input.auditDetails,
			})
		}
		if (outcome.result === 'success') {
			rememberResolvedFetchAudit({
				actor: input.actor,
				orgId: input.orgId,
				packageStamp: input.packageStamp,
				credential,
				subject,
				labels: subjects.flatMap((row) =>
					row.details?.placement ? [row.details.placement] : [],
				),
			})
		}
	}
	let result
	try {
		await assertActorHasOrgAccess(input)
		await assertSelfPublishedPackageResolvesNothing({
			env: input.env,
			request: input.actor,
			packageId: input.packageStamp?.packageId ?? input.runPackageId,
			credentialName: subject.name,
		})
		const packageId = input.packageStamp?.packageId ?? null
		const reference = credentialUseNeedReference(credential)
		if (packageId && reference) {
			await assertCredentialUsesDeclared({
				env: input.env,
				request: input.actor,
				orgId: input.orgId,
				packageId,
				references: [reference],
			})
		}
		const handle = await resolver.resolve({ input, credential, subject })
		await handle.authorize()
		const contextGrant = (credentialId: string | null) =>
			assertContextGrantAllowsCredential({
				actor: input.actor,
				credentialId,
				label: subject.name,
			})
		if (subject.credentialId) contextGrant(subject.credentialId)
		result = await handle.apply()
		// A resolver that found a credential without a stable id cannot be
		// matched to a context's list; the value is dropped, never returned.
		if (!subject.credentialId && resolver.isFound(result)) contextGrant(null)
	} catch (error) {
		audit(credentialResolutionOutcomeForError(error))
		const enablementId = enablementIdOf(input.actor)
		if (enablementId && error instanceof AuthorizationError) {
			await pauseEnablementOnDenial({
				db: input.env.APP_DB,
				orgId: input.orgId,
				enablementId,
				error,
				credentialResourceType: subject.resourceType,
			})
		}
		throw error
	}
	audit(
		resolver.isFound(result)
			? { result: 'success' }
			: { result: 'failure', reason: 'not_found' },
	)
	return result
}

type ResolvedFetchAudit = {
	subject: CredentialAuditSubject
	written: Set<string>
}

const resolvedFetchAudits = new WeakMap<
	RequestContext,
	Map<string, ResolvedFetchAudit>
>()

function fetchPlacementsOf(
	credential: CredentialTarget,
): ReadonlyArray<CredentialFetchPlacement> | null {
	switch (credential.use) {
		case 'secret':
		case 'provider-secret':
		case 'integration-token':
			return credential.placements ?? null
		case 'package-secret-mount':
		case 'webhook-secret':
		case 'integration-refresh':
		case 'mcp-connection':
		case 'url':
		case 'login':
		case 'signing':
		case 'client-key':
		case 'client-oauth':
		case 'client-oauth-refresh':
			return null
		default: {
			const exhaustive: never = credential
			throw new Error(`Unhandled credential use: ${String(exhaustive)}`)
		}
	}
}

/**
 * One audit subject per fetch placement. The resolver's subject stays the
 * object `authorize` mutates (credential id); placement is copied on at
 * write time so every row names the credential that was actually resolved.
 */
function auditSubjectFor(
	subject: CredentialAuditSubject,
	credential: CredentialTarget,
): Array<CredentialAuditSubject> {
	const placements = fetchPlacementsOf(credential)
	if (!placements || placements.length === 0) return [subject]
	const labels: Array<string> = []
	const seen = new Set<string>()
	for (const placement of placements) {
		const label = credentialFetchPlacementKey(placement)
		if (seen.has(label)) continue
		seen.add(label)
		labels.push(label)
	}
	if (labels.length === 0) return [subject]
	return labels.map((placement) => ({
		...subject,
		details: { ...subject.details, placement },
	}))
}

function fetchAuditCacheKey(input: {
	orgId: string
	packageStamp?: PackageStamp | null
	credential: CredentialTarget
}): string | null {
	const { credential } = input
	const identity = fetchCredentialIdentity(credential)
	if (!identity) return null
	const stamp = input.packageStamp
	const stampKey = stamp ? `${stamp.kind}:${stamp.packageId}` : 'none'
	return `${identity}\0${input.orgId}\0${stampKey}\0${fetchStorageKey(credential)}`
}

function fetchCredentialIdentity(credential: CredentialTarget): string | null {
	switch (credential.use) {
		case 'secret':
			return `secret\0${credential.requestHost ?? ''}\0${credential.scope ?? ''}\0${credential.name}`
		case 'integration-token':
			return `integration-token\0${credential.requestHost ?? ''}\0${credential.name}\0${credential.packageKodyId ?? ''}`
		case 'provider-secret':
			return `provider-secret\0${credential.requestHost ?? ''}\0${credential.provider}\0${credential.ref}`
		case 'package-secret-mount':
		case 'webhook-secret':
		case 'integration-refresh':
		case 'mcp-connection':
		case 'url':
		case 'login':
		case 'signing':
		case 'client-key':
		case 'client-oauth':
		case 'client-oauth-refresh':
			return null
		default: {
			const exhaustive: never = credential
			throw new Error(`Unhandled credential use: ${String(exhaustive)}`)
		}
	}
}

/** Package and storage buckets the resolution was authorized for. */
function fetchStorageKey(credential: CredentialTarget): string {
	switch (credential.use) {
		case 'secret':
		case 'provider-secret': {
			const storage = credential.storageContext
			return `${storage.packageId ?? ''}\0${storage.sessionId ?? ''}\0${storage.appId ?? ''}\0${storage.storageId ?? ''}`
		}
		case 'integration-token':
		case 'package-secret-mount':
		case 'webhook-secret':
		case 'integration-refresh':
		case 'mcp-connection':
		case 'url':
		case 'login':
		case 'signing':
		case 'client-key':
		case 'client-oauth':
		case 'client-oauth-refresh':
			return ''
		default: {
			const exhaustive: never = credential
			throw new Error(`Unhandled credential use: ${String(exhaustive)}`)
		}
	}
}

function rememberResolvedFetchAudit(input: {
	actor: RequestContext | null
	orgId: string
	packageStamp?: PackageStamp | null
	credential: CredentialTarget
	subject: CredentialAuditSubject
	labels: ReadonlyArray<string>
}) {
	const key = fetchAuditCacheKey(input)
	if (!input.actor || !key) return
	let byCredential = resolvedFetchAudits.get(input.actor)
	if (!byCredential) {
		byCredential = new Map()
		resolvedFetchAudits.set(input.actor, byCredential)
	}
	const existing = byCredential.get(key)
	if (existing) {
		existing.subject = input.subject
		for (const label of input.labels) existing.written.add(label)
		return
	}
	byCredential.set(key, {
		subject: input.subject,
		written: new Set(input.labels),
	})
}

function fetchCredentialObserveName(credential: CredentialTarget): string {
	switch (credential.use) {
		case 'secret':
		case 'integration-token':
			return credential.name
		case 'provider-secret':
			return `secret/${credential.provider.trim().toLowerCase()}`
		case 'package-secret-mount':
			return credential.alias
		case 'webhook-secret':
		case 'integration-refresh':
			return credential.name
		case 'mcp-connection':
			return credential.serverName
		case 'url':
		case 'login':
		case 'signing':
		case 'client-key':
		case 'client-oauth':
		case 'client-oauth-refresh':
			return credential.credentialId
		default: {
			const exhaustive: never = credential
			throw new Error(`Unhandled credential use: ${String(exhaustive)}`)
		}
	}
}

function fetchFillSitesOf(
	credential: CredentialTarget,
): ReadonlyArray<CredentialFillSite> {
	switch (credential.use) {
		case 'secret':
		case 'provider-secret':
		case 'integration-token':
			return credential.fillSites ?? []
		case 'package-secret-mount':
		case 'webhook-secret':
		case 'integration-refresh':
		case 'mcp-connection':
		case 'url':
		case 'login':
		case 'signing':
		case 'client-key':
		case 'client-oauth':
		case 'client-oauth-refresh':
			return []
		default: {
			const exhaustive: never = credential
			throw new Error(`Unhandled credential use: ${String(exhaustive)}`)
		}
	}
}

/**
 * Record fetch placements for a credential this request already resolved
 * successfully under the same org, package stamp, and storage buckets.
 * Returns true when that resolution exists, so the caller can skip another
 * read. A different authority is a miss: the caller resolves as usual.
 */
export function auditResolvedFetchPlacements(
	input: ResolveCredentialInput<CredentialTarget>,
): boolean {
	const key = fetchAuditCacheKey(input)
	const actor = input.actor
	if (!key || !actor) return false
	const cached = resolvedFetchAudits.get(actor)?.get(key)
	if (!cached) return false
	for (const subject of auditSubjectFor(cached.subject, input.credential)) {
		const placement = subject.details?.placement
		if (!placement || cached.written.has(placement)) continue
		cached.written.add(placement)
		scheduleCredentialResolutionAudit({
			env: input.env,
			orgId: input.orgId,
			actor,
			packageStamp: input.packageStamp,
			subject,
			outcome: { result: 'success' },
		})
	}
	const fillPlacement = readFetchFillPlacement(input)
	if (fillPlacement !== undefined) {
		const sites = fetchFillSitesOf(input.credential)
		if (sites.length > 0) {
			enforceFillPlacement({
				credentialName: fetchCredentialObserveName(input.credential),
				placement: fillPlacement,
				sites,
				surface: 'placeholder',
				env: input.env,
				credentialId:
					readFetchFillPlacementCredentialId(input) ??
					cached.subject.credentialId ??
					null,
				slot:
					input.credential.use === 'secret' ||
					input.credential.use === 'integration-token'
						? input.credential.name
						: null,
				links: readFetchFillPlacementRefusalLinks(input),
			})
		}
	}
	return true
}

const orgAccessByRequest = new WeakMap<RequestContext, Promise<void>>()

/**
 * Resolve-time org access: re-reads membership, team membership, and grants
 * instead of trusting the role the request was built with. Checked once per
 * request context, like compiled permissions.
 */
async function assertActorHasOrgAccess(
	input: ResolveCredentialInput<CredentialTarget>,
) {
	const request = input.actor
	if (!request) return
	const permission = permissionForUse(input.credential.use)
	if (request.org.id !== input.orgId) {
		throw new AuthorizationError({
			code: 'wrong_org',
			permission,
			orgId: request.org.id,
			resource: null,
			message: 'This credential belongs to another org.',
		})
	}
	const person = request.actor
	if (!person) return
	let check = orgAccessByRequest.get(request)
	if (!check) {
		check = (async () => {
			const hasAccess =
				(await loadOrgBindingForOrg(
					input.env.APP_DB,
					person.userId,
					input.orgId,
				)) !== null
			if (hasAccess) return
			throw new AuthorizationError({
				code: 'wrong_org',
				permission,
				orgId: input.orgId,
				resource: null,
				message:
					'You no longer have access to this org, so its credentials cannot be used.',
			})
		})()
		orgAccessByRequest.set(request, check)
		// Only a definite "no access" is cached; a failed lookup is retried.
		check.catch((error: unknown) => {
			if (!(error instanceof AuthorizationError)) {
				orgAccessByRequest.delete(request)
			}
		})
	}
	await check
}
