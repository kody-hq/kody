/**
 * Website adapter for the Agent profiles page (ADR 0092). Every read and
 * write goes through the existing profile capabilities and token
 * operations, so the page has exactly the authority MCP and the API have.
 */
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	callCapabilityAsWebsite,
	websiteCapabilityContext,
} from '#app/website-capability.ts'
import { getStaticRegistry } from '#mcp/capabilities/registry.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { createApiInvocationContext } from '#worker/open-api/context.ts'
import { invokeApiOperation } from '#worker/open-api/invoke.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { loadOrgBindingForSlug, type OrgBinding } from '#worker/orgs/repo.ts'
import { isProfilesEnabledFor } from '#worker/profiles/flag.ts'
import { profileOrgLevelAllowlist } from '#worker/profiles/rules.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { packageCollaboratorPermissions } from '#universal/package-collaborators.ts'
import {
	type ProfileGrantOption,
	type ProfileItem,
	type ProfilesPageData,
	type ProfileStatus,
	type ProfileTokenItem,
} from '#universal/profiles.ts'
import { routes } from '#universal/routes.ts'
import { readExecutionContextFailure } from './execution-contexts.ts'

type AppUser = NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>

type ScopedInput = {
	env: Env
	request: Request
	user: AppUser
	orgSlug: string
}

type ProfilesScope = {
	ctx: CapabilityContext
	binding: OrgBinding
	personal: boolean
}

export type ProfilesFailure = {
	ok: false
	error: string
	message: string
}

const profileStatuses = new Set<ProfileStatus>([
	'active',
	'expired',
	'revoked',
	'parent_inactive',
])

/** Packages offered as grants on a new top-level profile. */
const maxPackageGrantOptions = 200

async function loadScope(input: ScopedInput): Promise<ProfilesScope | null> {
	const binding = await loadOrgBindingForSlug(
		input.env.APP_DB,
		input.user.mcpUser.userId,
		input.orgSlug,
	)
	if (!binding) return null
	return {
		ctx: websiteCapabilityContext({ ...input, orgBinding: binding }),
		binding,
		personal: await isPersonalOrg(input.env.APP_DB, binding.org.id),
	}
}

async function callProfileCapability(
	scope: ProfilesScope,
	name: 'profileList' | 'profileCreate' | 'profileUpdate' | 'profileRevoke',
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const registry = await getStaticRegistry()
	const capability = registry.capabilityMap[name]
	if (!capability) throw new Error(`Missing capability ${name}`)
	const result = await callCapabilityAsWebsite(scope.ctx, capability, args)
	return result && typeof result === 'object'
		? (result as Record<string, unknown>)
		: {}
}

async function callTokenOperation(
	scope: ProfilesScope,
	env: Env,
	operationId: 'tokenList' | 'tokenCreate' | 'tokenRevoke',
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const callerContext = scope.ctx.callerContext
	const user = callerContext.user
	if (!user) throw new Error('Profile tokens need a signed-in person.')
	const result = await invokeApiOperation({
		operationId,
		params,
		ctx: createApiInvocationContext({
			env,
			callerContext: { ...callerContext, user },
			principal: { kind: 'mcp' },
		}),
	})
	return result && typeof result === 'object'
		? (result as Record<string, unknown>)
		: {}
}

function failureOf(error: unknown): ProfilesFailure | null {
	const failure = readExecutionContextFailure(error)
	if (!failure) return null
	return { ok: false, error: failure.error, message: failure.message }
}

async function runScoped<T>(
	input: ScopedInput,
	run: (scope: ProfilesScope) => Promise<T>,
): Promise<T | ProfilesFailure> {
	const scope = await loadScope(input)
	if (!scope)
		return { ok: false, error: 'not_found', message: 'Organization not found.' }
	try {
		return await run(scope)
	} catch (error) {
		const failure = failureOf(error)
		if (failure) return failure
		throw error
	}
}

function text(value: unknown): string | null {
	return typeof value === 'string' && value ? value : null
}

function rawProfiles(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value)
		? value.filter(
				(entry): entry is Record<string, unknown> =>
					Boolean(entry) && typeof entry === 'object',
			)
		: []
}

function inList(ids: ReadonlyArray<string>) {
	return ids.map(() => '?').join(', ')
}

/** D1 binds at most 100 parameters per statement. */
function chunks<T>(items: ReadonlyArray<T>, size = 90) {
	const out: Array<Array<T>> = []
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size))
	return out
}

async function packageLabels(
	db: D1Database,
	orgSlug: string,
	ids: Array<string>,
) {
	const labels = new Map<string, { label: string; href: string }>()
	if (!ids.length) return labels
	const rows = []
	for (const batch of chunks(ids)) {
		const result = await db
			.prepare(
				`SELECT id, name, kody_id FROM saved_packages
				 WHERE id IN (${inList(batch)})${andLiveDeletedAtSql()}`,
			)
			.bind(...batch)
			.all<{ id: string; name: string; kody_id: string }>()
		rows.push(...(result.results ?? []))
	}
	for (const row of rows) {
		labels.set(row.id, {
			label: row.name,
			href: routes.communityPackage.href({
				username: orgSlug,
				kodyId: row.kody_id,
			}),
		})
	}
	return labels
}

async function usernames(db: D1Database, ids: Array<string>) {
	const names = new Map<string, string>()
	if (!ids.length) return names
	for (const batch of chunks(ids)) {
		const rows = await db
			.prepare(
				`SELECT stable_user_id, username FROM users
				 WHERE stable_user_id IN (${inList(batch)})${andLiveDeletedAtSql()}`,
			)
			.bind(...batch)
			.all<{ stable_user_id: string; username: string }>()
		for (const row of rows.results ?? []) {
			names.set(row.stable_user_id, row.username)
		}
	}
	return names
}

async function toProfileItems(
	db: D1Database,
	orgSlug: string,
	orgId: string,
	raw: Array<Record<string, unknown>>,
): Promise<Array<ProfileItem>> {
	const packageIds = new Set<string>()
	const people = new Set<string>()
	for (const profile of raw) {
		const acting = text(profile.actingUserId)
		if (acting) people.add(acting)
		for (const grant of rawProfiles(profile.grants)) {
			const id = text(grant.resourceId)
			if (grant.resourceType === 'package' && id) packageIds.add(id)
		}
	}
	const [packages, handles] = await Promise.all([
		packageLabels(db, orgSlug, [...packageIds]),
		usernames(db, [...people]),
	])
	return raw.flatMap((profile) => {
		const id = text(profile.id)
		const name = text(profile.name)
		const actingUserId = text(profile.actingUserId)
		const status = profile.status as ProfileStatus
		if (!id || !name || !actingUserId || !profileStatuses.has(status)) return []
		const grants = rawProfiles(profile.grants).flatMap((grant) => {
			const resourceType = text(grant.resourceType)
			const resourceId = text(grant.resourceId)
			if (!resourceType || !resourceId) return []
			const permissions = Array.isArray(grant.permissions)
				? grant.permissions.filter(
						(permission): permission is string =>
							typeof permission === 'string',
					)
				: []
			const pkg =
				resourceType === 'package' ? packages.get(resourceId) : undefined
			return [
				{
					resourceType,
					resourceId,
					permissions,
					label:
						pkg?.label ??
						(resourceType === 'org' && resourceId === orgId
							? `@${orgSlug}`
							: null),
					href: pkg?.href ?? null,
				},
			]
		})
		const chain = rawProfiles(profile.chain).flatMap((entry) => {
			const entryId = text(entry.id)
			const entryName = text(entry.name)
			return entryId && entryName ? [{ id: entryId, name: entryName }] : []
		})
		return [
			{
				id,
				name,
				parentProfileId: text(profile.parentProfileId),
				actingUserId,
				actingHandle: handles.get(actingUserId) ?? null,
				depth: typeof profile.depth === 'number' ? profile.depth : 1,
				status,
				expiresAt: text(profile.expiresAt),
				effectiveExpiresAt: text(profile.effectiveExpiresAt),
				revokedAt: text(profile.revokedAt),
				createdAt: text(profile.createdAt) ?? '',
				chain,
				grants,
			},
		]
	})
}

function toTokenItems(value: unknown, orgId: string): Array<ProfileTokenItem> {
	return rawProfiles(value).flatMap((token) => {
		const id = text(token.id)
		const profileId = text(token.profile_id)
		const status = token.status
		if (
			!id ||
			!profileId ||
			token.org_id !== orgId ||
			(status !== 'active' && status !== 'expired' && status !== 'revoked')
		)
			return []
		return [
			{
				id,
				name: text(token.name) ?? id,
				profileId,
				status,
				scopes: Array.isArray(token.scopes)
					? token.scopes.filter(
							(scope): scope is string => typeof scope === 'string',
						)
					: [],
				expiresAt: text(token.expires_at) ?? '',
				maxExpiresAt: text(token.max_expires_at) ?? '',
				lastUsedAt: text(token.last_used_at),
				createdAt: text(token.created_at) ?? '',
			},
		]
	})
}

async function loadGrantOptions(
	db: D1Database,
	orgId: string,
	orgSlug: string,
): Promise<Array<ProfileGrantOption>> {
	const packages = await db
		.prepare(
			`SELECT id, name FROM saved_packages
			 WHERE user_id = ?${andLiveDeletedAtSql()}
			 ORDER BY name ASC LIMIT ?`,
		)
		.bind(orgId, maxPackageGrantOptions)
		.all<{ id: string; name: string }>()
	return [
		{
			resourceType: 'org',
			resourceId: orgId,
			label: `@${orgSlug} (org-level)`,
			permissions: [...profileOrgLevelAllowlist],
		},
		...(packages.results ?? []).map((row) => ({
			resourceType: 'package',
			resourceId: row.id,
			label: row.name,
			permissions: [...packageCollaboratorPermissions],
		})),
	]
}

export async function loadProfilesPageData(
	input: ScopedInput & { allMembers: boolean },
): Promise<ProfilesPageData | { notFound: true }> {
	const scope = await loadScope(input)
	if (!scope) return { notFound: true }
	const db = input.env.APP_DB
	const org = scope.binding.org
	const userId = input.user.mcpUser.userId
	if (!(await isProfilesEnabledFor(db, userId, org.id))) {
		return { enabled: false, orgSlug: input.orgSlug }
	}
	const isOwner = scope.personal || scope.binding.role === 'owner'
	const allMembers = input.allMembers && isOwner && !scope.personal
	const viewer = { userId, username: input.user.username, isOwner }
	try {
		const [listed, tokens, grantOptions] = await Promise.all([
			callProfileCapability(
				scope,
				'profileList',
				allMembers ? { all_members: true } : {},
			),
			callTokenOperation(scope, input.env, 'tokenList', {
				include_inactive: true,
			}),
			loadGrantOptions(db, org.id, input.orgSlug),
		])
		return {
			enabled: true,
			orgSlug: input.orgSlug,
			orgId: org.id,
			personalOrg: scope.personal,
			viewer,
			allMembers,
			profiles: await toProfileItems(
				db,
				input.orgSlug,
				org.id,
				rawProfiles(listed.profiles),
			),
			tokens: toTokenItems(tokens.tokens, org.id),
			grantOptions,
			listError: null,
		}
	} catch (error) {
		const failure = failureOf(error)
		if (!failure) throw error
		return {
			enabled: true,
			orgSlug: input.orgSlug,
			orgId: org.id,
			personalOrg: scope.personal,
			viewer,
			allMembers,
			profiles: [],
			tokens: [],
			grantOptions: [],
			listError: failure.message,
		}
	}
}

export type ProfileGrantInput = {
	resourceType: string
	resourceId: string
	permissions: Array<string>
}

export async function createProfileForUser(
	input: ScopedInput & {
		name: string
		parentProfileId: string | null
		expiresAt: string | null
		grants: Array<ProfileGrantInput>
	},
) {
	return runScoped(input, async (scope) => {
		const created = await callProfileCapability(scope, 'profileCreate', {
			name: input.name,
			...(input.parentProfileId
				? { parent_profile_id: input.parentProfileId }
				: {}),
			...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
			grants: input.grants.map((grant) => ({
				resource_type: grant.resourceType,
				resource_id: grant.resourceId,
				permissions: grant.permissions,
			})),
		})
		return { ok: true as const, profileId: text(created.id) }
	})
}

export async function shortenProfileExpiryForUser(
	input: ScopedInput & { profileId: string; expiresAt: string },
) {
	return runScoped(input, async (scope) => {
		await callProfileCapability(scope, 'profileUpdate', {
			profile_id: input.profileId,
			expires_at: input.expiresAt,
		})
		return { ok: true as const }
	})
}

export async function revokeProfileForUser(
	input: ScopedInput & { profileId: string },
) {
	return runScoped(input, async (scope) => {
		await callProfileCapability(scope, 'profileRevoke', {
			profile_id: input.profileId,
		})
		return { ok: true as const }
	})
}

/** The plaintext comes back once, to this response only; never log it. */
export async function createProfileTokenForUser(
	input: ScopedInput & {
		profileId: string
		name: string
		scopes: Array<string>
		lifetime: 'short' | 'long'
	},
) {
	return runScoped(input, async (scope) => {
		const created = await callTokenOperation(scope, input.env, 'tokenCreate', {
			name: input.name,
			profile_id: input.profileId,
			scopes: input.scopes,
			lifetime: input.lifetime,
		})
		const token = text(created.token)
		const id = text(created.id)
		if (!token || !id) throw new Error('tokenCreate returned no token.')
		return { ok: true as const, tokenId: id, token }
	})
}

export async function revokeProfileTokenForUser(
	input: ScopedInput & { tokenId: string },
) {
	return runScoped(input, async (scope) => {
		const listed = await callTokenOperation(scope, input.env, 'tokenList', {
			include_inactive: true,
		})
		const bound = toTokenItems(listed.tokens, scope.binding.org.id).some(
			(token) => token.id === input.tokenId,
		)
		if (!bound)
			return {
				ok: false as const,
				error: 'not_found',
				message: 'That profile token was not found.',
			}
		await callTokenOperation(scope, input.env, 'tokenRevoke', {
			token_id: input.tokenId,
		})
		return { ok: true as const }
	})
}
