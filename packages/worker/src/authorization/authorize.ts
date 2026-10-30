import { AsyncLocalStorage } from 'node:async_hooks'
import {
	isGrantablePermission,
	isOrgWideReadPermission,
} from '@kody-internal/shared/grant-presets.ts'
import {
	orgPermissions,
	type OrgGrantResourceType,
	type OrgPermission,
} from '@kody-internal/shared/org-permissions.ts'
import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	connectionProfileAllows,
	type ConnectionProfileAction,
	type ConnectionProfileGrant,
} from '#universal/connection-profiles/grants.ts'
import { resolveConnectionProfileGrants } from '#worker/connection-profiles/repo.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	compiledAccessExpired,
	compileAccessForRequest,
	resourceGrantKey,
	type CompiledAccess,
} from './access-compile.ts'
import { memberCreationKindFor } from './member-creation-permissions.ts'

/** A concrete org resource a permission is checked on. */
export type OrgResource = {
	type: OrgGrantResourceType
	id: string
	orgId: OwnerId
	/** Human-readable name for denial messages (package name, credential name, inbox address). */
	label?: string
}

/**
 * What one request may do in its org: the compiled role and grant
 * permissions, then what its credential narrows that to.
 */
export type EffectivePermissions = {
	orgId: OwnerId
	/** Org-level permissions (role basics + grants on the org resource). */
	permissions: ReadonlySet<OrgPermission>
	/** True when the actor is an Owner. */
	isOwner: boolean
	/** Per-resource grants keyed by `${type}:${id}`. */
	resourcePermissions: ReadonlyMap<string, ReadonlySet<OrgPermission>>
	credentialScopes: ReadonlySet<OrgPermission> | null
	/** Null when no connection profile is bound to the credential. */
	profileGrants: ReadonlyArray<ConnectionProfileGrant> | null
	/** Earliest grant expiry the compile used; stale from then on. */
	validUntil?: string | null
}

export type AuthorizationDenialCode =
	| 'unauthenticated'
	| 'wrong_org'
	| 'missing_permission'
	| 'credential_scope'
	| 'connection_profile'

/**
 * A request lacks a permission. Callers can clear it (sign in, use another
 * credential, ask for a grant), so it is an `McpCallerError`.
 */
export class AuthorizationError extends McpCallerError {
	readonly code: AuthorizationDenialCode
	readonly permission: OrgPermission
	readonly orgId: OwnerId | null
	readonly resource: OrgResource | null
	/**
	 * For `credential_scope`: the credential's scopes plus the missing one, so
	 * callers can mint a replacement token without guessing the full list.
	 */
	readonly mintScopes: ReadonlyArray<OrgPermission> | null

	constructor(input: {
		code: AuthorizationDenialCode
		permission: OrgPermission
		orgId: OwnerId | null
		resource: OrgResource | null
		message: string
		mintScopes?: ReadonlyArray<OrgPermission> | null
	}) {
		super(input.message)
		this.name = 'AuthorizationError'
		this.code = input.code
		this.permission = input.permission
		this.orgId = input.orgId
		this.resource = input.resource
		this.mintScopes = input.mintScopes ?? null
	}
}

export type AuthorizationDecision =
	| { allowed: true }
	| { allowed: false; error: AuthorizationError }

async function loadProfileGrants(
	env: Env,
	request: RequestContext,
): Promise<ReadonlyArray<ConnectionProfileGrant> | null> {
	const { profileName } = request.credential
	if (!profileName) return null
	// Profiles belong to the account that minted the credential. Automation
	// keeps the profile of the credential that created the job or webhook,
	// and that account is the org's own until orgs have members.
	return await resolveConnectionProfileGrants({
		db: env.APP_DB,
		userId: request.actor?.userId ?? request.org.id,
		profileName,
	})
}

function toEffective(
	compiled: CompiledAccess,
	request: RequestContext,
	profileGrants: ReadonlyArray<ConnectionProfileGrant> | null,
): EffectivePermissions {
	return {
		orgId: compiled.orgId,
		permissions: compiled.orgPermissions,
		isOwner: compiled.isOwner,
		resourcePermissions: compiled.resourcePermissions,
		credentialScopes: request.credential.scopes
			? new Set(request.credential.scopes)
			: null,
		profileGrants,
		validUntil: compiled.validUntil,
	}
}

const effectivePermissionsByRequest = new WeakMap<
	RequestContext,
	Promise<EffectivePermissions>
>()

/**
 * Compile what `request` may do in its org. Cached per request context, so a
 * request that checks many permissions loads its grants once, until a grant
 * the compile used expires.
 */
export function computeEffectivePermissions(input: {
	env: Env
	request: RequestContext
}): Promise<EffectivePermissions> {
	const cached = effectivePermissionsByRequest.get(input.request)
	if (!cached) return loadEffectivePermissions(input)
	return cached.then((effective) =>
		compiledAccessExpired({ validUntil: effective.validUntil ?? null })
			? loadEffectivePermissions(input)
			: effective,
	)
}

function loadEffectivePermissions(input: {
	env: Env
	request: RequestContext
}): Promise<EffectivePermissions> {
	const promise = (async () => {
		const compiled = await compileAccessForRequest({
			db: input.env.APP_DB,
			request: input.request,
		})
		const profileGrants = await loadProfileGrants(input.env, input.request)
		return toEffective(compiled, input.request, profileGrants)
	})()
	effectivePermissionsByRequest.set(input.request, promise)
	promise.catch(() => {
		if (effectivePermissionsByRequest.get(input.request) === promise) {
			effectivePermissionsByRequest.delete(input.request)
		}
	})
	return promise
}

/**
 * Permissions that narrow to the profile `write` action. Delete and publish
 * have no profile action of their own; a bound profile must list `write`.
 */
const profileWritePermissions = [
	'package:write',
	'package:delete',
	'package:publish',
] as const

type ProfileWritePermission = (typeof profileWritePermissions)[number]

function isProfileWritePermission(
	permission: OrgPermission,
): permission is ProfileWritePermission {
	return (profileWritePermissions as ReadonlyArray<OrgPermission>).includes(
		permission,
	)
}

function profileActionFor(
	permission: OrgPermission,
): ConnectionProfileAction | null {
	if (permission === 'package:read') return 'read'
	if (permission === 'package:execute') return 'execute'
	if (isProfileWritePermission(permission)) return 'write'
	return null
}

/**
 * Connection profiles list package grants only, so they narrow package
 * resources and leave every other check to the role and credential.
 */
function profileAllows(
	grants: ReadonlyArray<ConnectionProfileGrant> | null,
	permission: OrgPermission,
	resource: OrgResource,
) {
	if (grants === null || resource.type !== 'package') return true
	const action = profileActionFor(permission)
	if (!action) return false
	return connectionProfileAllows({
		grants,
		resourceType: resource.type,
		resourceId: resource.id,
		action,
	})
}

function describeResource(resource: OrgResource, permission: OrgPermission) {
	// A credential is keyed by id, but people name it by family and name.
	const noun =
		resource.type === 'credential' ? permission.split(':')[0] : resource.type
	return `${noun} ${resource.label ?? `"${resource.id}"`}`
}

function holdsPermission(
	access: EffectivePermissions,
	permission: OrgPermission,
	resource: OrgResource | undefined,
) {
	if (access.isOwner) return true
	if (access.permissions.has(permission)) return true
	if (resource) {
		const granted = access.resourcePermissions.get(
			resourceGrantKey(resource.type, resource.id),
		)
		return granted?.has(permission) ?? false
	}
	// Surface / discovery checks (§6.3): the permission is held somewhere in
	// the org when any resource grant includes it.
	for (const granted of access.resourcePermissions.values()) {
		if (granted.has(permission)) return true
	}
	return false
}

function deny(input: {
	code: AuthorizationDenialCode
	permission: OrgPermission
	access: EffectivePermissions
	resource: OrgResource | undefined
	message: string
}): AuthorizationDecision {
	return {
		allowed: false,
		error: new AuthorizationError({
			code: input.code,
			permission: input.permission,
			orgId: input.access.orgId,
			resource: input.resource ?? null,
			message: input.message,
			mintScopes:
				input.code === 'credential_scope'
					? credentialMintScopes(input.access, input.permission)
					: null,
		}),
	}
}

/** The credential's scopes plus `permission`, sorted for a stable command. */
function credentialMintScopes(
	access: EffectivePermissions,
	permission: OrgPermission,
): Array<OrgPermission> {
	return [...new Set([...(access.credentialScopes ?? []), permission])].sort()
}

function denialCode(
	access: EffectivePermissions,
	permission: OrgPermission,
	resource: OrgResource | undefined,
): AuthorizationDenialCode | null {
	if (resource && resource.orgId !== access.orgId) return 'wrong_org'
	if (!holdsPermission(access, permission, resource)) {
		return 'missing_permission'
	}
	if (access.credentialScopes && !access.credentialScopes.has(permission)) {
		return 'credential_scope'
	}
	if (resource && !profileAllows(access.profileGrants, permission, resource)) {
		return 'connection_profile'
	}
	return null
}

function ownerCanGrant(
	permission: OrgPermission,
	resource: OrgResource | undefined,
) {
	if (resource) return 'An org Owner can grant it.'
	const creationKind = memberCreationKindFor(permission)
	if (creationKind) {
		const setting =
			creationKind === 'packages'
				? 'Members can create packages and apps'
				: 'Members can create credentials'
		return `An org Owner controls this: they can turn on "${setting}" in organization settings, or grant ${permission} to you or your team on the Grants page.`
	}
	if (isOrgWideReadPermission(permission)) {
		return 'An org Owner can grant it org-wide on the Grants page or with accessGrant resource_type org.'
	}
	if (isGrantablePermission('org', permission)) {
		return 'An org Owner can grant it org-wide with accessGrant resource_type org.'
	}
	return 'An org Owner can grant it.'
}

function denialMessage(
	code: AuthorizationDenialCode,
	permission: OrgPermission,
	resource: OrgResource | undefined,
	mintScopes: ReadonlyArray<OrgPermission> = [permission],
) {
	const target = resource ? ` on ${describeResource(resource, permission)}` : ''
	switch (code) {
		case 'unauthenticated':
			return `Authenticated MCP user is required for this capability. It needs ${permission}.`
		case 'wrong_org':
			return `${resource ? describeResource(resource, permission) : 'This resource'} belongs to another org.`
		case 'missing_permission':
			return `Missing ${permission}${target}. ${ownerCanGrant(permission, resource)}`
		case 'credential_scope':
			return `This credential is not scoped for ${permission}${target}. Mint a token that adds it: from Kody MCP, call cliCredentialBootstrap({ lifetime: "short", scopes: [${mintScopes.map((scope) => JSON.stringify(scope)).join(', ')}] }) and run the returned cli_command; or after \`kody login\`, run \`npx @kodycodes/cli auth bootstrap --lifetime short --scopes ${mintScopes.join(',')}\`. Use those scopes with tokenCreate only for CI/headless.`
		case 'connection_profile': {
			if (permission === 'package:create') {
				return 'This connection profile cannot create packages.'
			}
			const action = profileActionFor(permission) ?? permission
			return `This connection profile cannot ${action}${resource ? ` ${describeResource(resource, permission)}` : ''}.`
		}
		default: {
			const exhaustive: never = code
			throw new Error(`Unhandled denial code: ${String(exhaustive)}`)
		}
	}
}

/**
 * The pure decision behind `authorize`, for callers that already hold the
 * compiled permissions and check many resources at once.
 */
export function checkPermission(
	access: EffectivePermissions,
	permission: OrgPermission,
	resource?: OrgResource,
): AuthorizationDecision {
	const code = denialCode(access, permission, resource)
	if (!code) return { allowed: true }
	return deny({
		code,
		permission,
		access,
		resource,
		message: denialMessage(
			code,
			permission,
			resource,
			credentialMintScopes(access, permission),
		),
	})
}

const packageVisibilityPermissions: ReadonlyArray<OrgPermission> = [
	'package:read',
	'package:execute',
	'package:write',
]

/**
 * Whether a list or search result may show `resource`: the request holds at
 * least one permission on it. A profile that only grants `execute` still
 * shows the package, so it can be invoked.
 */
export function canSeeResource(
	access: EffectivePermissions,
	resource: OrgResource,
) {
	return packageVisibilityPermissions.some(
		(permission) => denialCode(access, permission, resource) === null,
	)
}

/**
 * Which rows of one resource type a list, search, or history may return for
 * `permission`. Owners and org-level holders see every row; anyone else sees
 * only resources they hold a grant on. The surface check passes on a single
 * resource grant, so a list that skips this returns the whole org.
 */
export type ResourceListScope =
	| { kind: 'all' }
	| { kind: 'granted'; ids: ReadonlySet<string> }

function holdsOrgWide(access: EffectivePermissions, permission: OrgPermission) {
	if (access.credentialScopes && !access.credentialScopes.has(permission)) {
		return false
	}
	return access.isOwner || access.permissions.has(permission)
}

export function resourceListScope(
	access: EffectivePermissions,
	permission: OrgPermission,
	resourceType: OrgGrantResourceType,
): ResourceListScope {
	const ids = new Set<string>()
	if (access.credentialScopes && !access.credentialScopes.has(permission)) {
		return { kind: 'granted', ids }
	}
	if (holdsOrgWide(access, permission)) return { kind: 'all' }
	const prefix = `${resourceType}:`
	for (const [key, granted] of access.resourcePermissions) {
		if (key.startsWith(prefix) && granted.has(permission)) {
			ids.add(key.slice(prefix.length))
		}
	}
	return { kind: 'granted', ids }
}

export function listScopeIncludes(scope: ResourceListScope, id: string) {
	return scope.kind === 'all' || scope.ids.has(id)
}

/**
 * Search visibility for non-package resources: a row shows when the request
 * holds any of `permissions` on it (org-wide or by grant).
 */
export function resourceVisibility(
	access: EffectivePermissions,
	resourceType: OrgGrantResourceType,
	permissions: ReadonlyArray<OrgPermission>,
): (id: string) => boolean {
	const scopes = permissions.map((permission) =>
		resourceListScope(access, permission, resourceType),
	)
	return (id) => scopes.some((scope) => listScopeIncludes(scope, id))
}

function requireRequest(
	ctx: { request: RequestContext | null },
	permission: OrgPermission,
): RequestContext {
	if (ctx.request) return ctx.request
	throw new AuthorizationError({
		code: 'unauthenticated',
		permission,
		orgId: null,
		resource: null,
		message: denialMessage('unauthenticated', permission, undefined),
	})
}

export async function loadResourceListScope(
	ctx: { env: Env; request: RequestContext | null },
	permission: OrgPermission,
	resourceType: OrgGrantResourceType,
): Promise<ResourceListScope> {
	const request = requireRequest(ctx, permission)
	const access = await computeEffectivePermissions({ env: ctx.env, request })
	return resourceListScope(access, permission, resourceType)
}

/**
 * For surfaces that read or change org-wide state of a resource type (run
 * history, workflow runs, bulk triage): a grant on one resource is not enough.
 */
export async function authorizeOrgWide(
	ctx: { env: Env; request: RequestContext | null },
	permission: OrgPermission,
): Promise<void> {
	const request = requireRequest(ctx, permission)
	const access = await computeEffectivePermissions({ env: ctx.env, request })
	const decision = checkOrgWide(access, permission)
	if (!decision.allowed) throw decision.error
}

/**
 * The pure decision behind `authorizeOrgWide`. Only a credential whose actor
 * already holds `permission` org-wide gets the mint-a-token hint; otherwise a
 * new token cannot help and the denial is the role's.
 */
export function checkOrgWide(
	access: EffectivePermissions,
	permission: OrgPermission,
): AuthorizationDecision {
	if (holdsOrgWide(access, permission)) return { allowed: true }
	const roleHoldsOrgWide = access.isOwner || access.permissions.has(permission)
	if (roleHoldsOrgWide) {
		return deny({
			code: 'credential_scope',
			permission,
			access,
			resource: undefined,
			message: denialMessage(
				'credential_scope',
				permission,
				undefined,
				credentialMintScopes(access, permission),
			),
		})
	}
	return deny({
		code: 'missing_permission',
		permission,
		access,
		resource: undefined,
		message: `Missing ${permission} across this org. A grant on one resource does not cover org-wide reads. ${ownerCanGrant(permission, undefined)}`,
	})
}

/** A resource in the request's own org, keyed the way grants store it. */
export function orgResource(
	request: RequestContext,
	type: OrgGrantResourceType,
	id: string,
	label?: string,
): OrgResource {
	return { type, id, orgId: request.org.id, label }
}

/**
 * The org resource for a saved package, bound to the org that owns it
 * (`saved_packages.user_id`). A package from another org is denied with
 * `wrong_org`.
 */
export function packageResource(input: {
	id: string
	userId: string
	label?: string
}): OrgResource {
	return {
		type: 'package',
		id: input.id,
		orgId: ownerIdFromStored(input.userId),
		label: input.label,
	}
}

/**
 * The one profile-write check for a resolved saved package. `package:write`,
 * `package:delete`, and `package:publish` all map to the profile `write`
 * action. Call it once the package row is known, before the mutation.
 */
export async function authorizePackageWrite(
	ctx: { env: Env; request: RequestContext | null },
	pkg: { id: string; userId: string; label?: string },
	permission: ProfileWritePermission = 'package:write',
): Promise<void> {
	await authorize(ctx, permission, packageResource(pkg))
}

/**
 * The one check for creating a saved package (`packageSave` and
 * `packageGetGitRemote` when the package does not exist yet, `communityFork`,
 * `repoPromoteToPackage`). Creation needs org-level `package:create`, never
 * org-wide `package:write`, which no org grant can hold. Writes to existing
 * packages stay on `authorizePackageWrite`.
 *
 * A bound profile names existing packages, so it cannot create one. Plain
 * `repoCreate` keeps its own `package:create` check and is unaffected.
 */
export async function authorizePackageCreate(ctx: {
	env: Env
	request: RequestContext | null
}): Promise<void> {
	await authorize(ctx, 'package:create')
	if (!ctx.request?.credential.profileName) return
	const access = await computeEffectivePermissions({
		env: ctx.env,
		request: ctx.request,
	})
	if (access.profileGrants === null) return
	throw new AuthorizationError({
		code: 'connection_profile',
		permission: 'package:create',
		orgId: access.orgId,
		resource: null,
		message: 'This connection profile cannot create packages.',
	})
}

const requestPermissionsStorage = new AsyncLocalStorage<EffectivePermissions>()

/**
 * Bind the request's permissions for deep call sites that do not carry a
 * caller context (package import resolution). No request binds nothing.
 */
export async function runWithRequestPermissions<T>(
	ctx: { env: Env; request: RequestContext | null },
	run: () => Promise<T>,
): Promise<T> {
	if (!ctx.request) return await run()
	const access = await computeEffectivePermissions({
		env: ctx.env,
		request: ctx.request,
	})
	return await requestPermissionsStorage.run(access, run)
}

/** The permissions bound by `runWithRequestPermissions`, if any. */
export function getRequestPermissions(): EffectivePermissions | undefined {
	return requestPermissionsStorage.getStore()
}

/**
 * The one org access check (docs/contributing/architecture/authorization.md).
 * Without `resource` it checks an org-level permission. Throws
 * `AuthorizationError` on denial. Site-admin checks are separate.
 */
export async function authorize(
	ctx: { env: Env; request: RequestContext | null },
	permission: OrgPermission,
	resource?: OrgResource,
): Promise<void> {
	if (!ctx.request) {
		throw new AuthorizationError({
			code: 'unauthenticated',
			permission,
			orgId: null,
			resource: resource ?? null,
			message: denialMessage('unauthenticated', permission, resource),
		})
	}
	const access = await computeEffectivePermissions({
		env: ctx.env,
		request: ctx.request,
	})
	const decision = checkPermission(access, permission, resource)
	if (!decision.allowed) throw decision.error
}

/**
 * Checks only what the request credential allows, for a write the actor makes
 * on their own data rather than on the request's org: a personal credential's
 * org grants. A token must carry `permission`, and a token narrowed by a
 * connection profile can't make such writes at all.
 */
export function authorizeCredentialScope(
	request: RequestContext,
	permission: OrgPermission,
): void {
	if (request.credential.profileName) {
		throw new AuthorizationError({
			code: 'connection_profile',
			permission,
			orgId: request.org.id,
			resource: null,
			message: `This credential is narrowed by a connection profile, so it cannot use ${permission} on your personal credentials. Use your own session or an unprofiled token.`,
		})
	}
	const scopes = request.credential.scopes
	if (!scopes || scopes.includes(permission)) return
	const mintScopes = [...new Set([...scopes, permission])].sort()
	throw new AuthorizationError({
		code: 'credential_scope',
		permission,
		orgId: request.org.id,
		resource: null,
		message: denialMessage(
			'credential_scope',
			permission,
			undefined,
			mintScopes,
		),
		mintScopes,
	})
}

/**
 * What a capability or Open API operation requires. `none` declares that it
 * touches no org data (who-am-I, static guides, site-admin tools, which
 * `requiredRole` gates instead). A list passes when any one is held, for a
 * surface whose handler picks the permission per call (create vs update).
 */
export type SurfacePermission =
	| OrgPermission
	| 'none'
	| readonly [OrgPermission, OrgPermission, ...Array<OrgPermission>]

export function surfacePermissionList(
	permission: SurfacePermission,
): ReadonlyArray<OrgPermission> {
	if (permission === 'none') return []
	return typeof permission === 'string' ? [permission] : permission
}

/**
 * A capability that needs a live person ran without one: from a triggered
 * run (cron job, webhook, subscription, inbound email), from package code one
 * of those started, or from a package app. The actor's role does not matter.
 */
export class LivePersonRequiredError extends McpCallerError {
	readonly capabilityName: string

	constructor(capabilityName: string) {
		super(
			`Capability "${capabilityName}" needs a live person. Call it from a web session, an interactive MCP or CLI call, or an ad hoc execute. It never runs from a job, webhook, subscription, or inbound email handler, or from package code one of those started, even when the person who turned that trigger on is an Owner.`,
		)
		this.name = 'LivePersonRequiredError'
		this.capabilityName = capabilityName
	}
}

/**
 * Whether a person is directly behind `request`: a web session, an MCP or
 * CLI call, or an API token they hold. Runs nested in one of those keep its
 * credential, so an ad hoc execute counts. Triggered runs keep the trigger's
 * credential down every nested run, so nothing they start counts.
 */
export function isLivePersonRequest(request: RequestContext | null): boolean {
	if (!request?.actor) return false
	const kind = request.credential.kind
	switch (kind) {
		case 'session':
		case 'mcp-oauth':
		case 'cli':
		case 'api-token':
			return true
		case 'package-app':
		case 'schedule':
		case 'webhook':
		case 'inbound-email':
		case 'platform-event':
		// A machine acting for the requester while their run is active is
		// never a live person (ECP 8.2), so requiresLivePerson denies.
		case 'execution-context-run':
			return false
		default: {
			const exhaustive: never = kind
			throw new Error(`Unhandled credential kind: ${String(exhaustive)}`)
		}
	}
}

export type NonInteractiveTriggerType =
	| 'job'
	| 'webhook'
	| 'subscription'
	| 'email'
	| 'package-app'
	/** A person's credential with no person resolved behind it. */
	| 'unattended'

export type NonInteractiveTrigger = {
	type: NonInteractiveTriggerType
	/**
	 * The run's credential id: the enablement id when an enablement runs it
	 * (its row names the job, endpoint, topic, or address), else the job,
	 * webhook, or event source id. Null for a package app.
	 */
	credentialId: string | null
}

/**
 * The trigger behind a request no live person made, including package code
 * one started (lineage keeps the trigger credential). Null when a live person
 * is behind `request` ({@link isLivePersonRequest}) or there is no request.
 */
export function nonInteractiveTriggerOf(
	request: RequestContext | null,
): NonInteractiveTrigger | null {
	if (!request || isLivePersonRequest(request)) return null
	const { kind, id } = request.credential
	switch (kind) {
		case 'schedule':
			return { type: 'job', credentialId: id }
		case 'webhook':
			return { type: 'webhook', credentialId: id }
		case 'platform-event':
			return { type: 'subscription', credentialId: id }
		case 'inbound-email':
			return { type: 'email', credentialId: id }
		case 'package-app':
			return { type: 'package-app', credentialId: id }
		case 'session':
		case 'mcp-oauth':
		case 'cli':
		case 'api-token':
		case 'execution-context-run':
			return { type: 'unattended', credentialId: id }
		default: {
			const exhaustive: never = kind
			throw new Error(`Unhandled credential kind: ${String(exhaustive)}`)
		}
	}
}

/** Refuse `capabilityName` unless a live person is behind `request`. */
export function assertLivePerson(
	request: RequestContext | null,
	capabilityName: string,
): void {
	if (!isLivePersonRequest(request)) {
		throw new LivePersonRequiredError(capabilityName)
	}
}

/**
 * The dispatch gate every capability and Open API operation passes. The
 * permission (or one from a list) must be held in the org; handlers then call `authorize` with
 * the concrete resource.
 */
export async function authorizeSurface(
	ctx: { env: Env; request: RequestContext | null },
	permission: SurfacePermission,
): Promise<void> {
	const [first, ...rest] = surfacePermissionList(permission)
	if (!first) return
	try {
		await authorize(ctx, first)
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error
		for (const alternative of rest) {
			const allowed = await authorize(ctx, alternative).then(
				() => true,
				(caught: unknown) => {
					if (caught instanceof AuthorizationError) return false
					throw caught
				},
			)
			if (allowed) return
		}
		throw error
	}
}

// Re-export so callers that only need the vocabulary keep one import path.
export { orgPermissions }
