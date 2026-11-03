import {
	personIdFromStored,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import {
	getUserRolesAndPermissions,
	parseUserRolesAndPermissionRows,
	userRolesAndPermissionsByStableIdStatement,
	type PermissionRow,
} from '#worker/identity/permissions-db.ts'
import {
	evictMcpAuthCache,
	mcpAuthCacheEntryMatches,
	orgEpochFromRow,
	orgEpochStatement,
	readMcpAuthCache,
	writeMcpAuthCache,
	type OrgEpochRow,
} from '#worker/mcp-auth-cache.ts'
import { readOrgIdFromGrantProps } from '#worker/orgs/oauth-grant.ts'
import {
	displayNameFromEmail,
	getUsernameFormatValidationError,
} from '#worker/identity/username.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	planOrgBindingFromGrantProps,
	type OrgBindingPlan,
} from '#worker/orgs/grant-binding.ts'
import { type OrgBinding } from '#worker/orgs/repo.ts'

type McpOAuthGrantProps = {
	userId?: unknown
	email?: unknown
	username?: unknown
	displayName?: unknown
} | null

type GrantUserRow = {
	id: number
	email: string
	username: string | null
	display_name: string | null
	stable_user_id: string
	personal_org_id: string | null
	deleting_at: string | null
	email_verified_at: string | null
	suspended_at: string | null
	password_changed_at: string | null
}

export type McpAuthUserContext = {
	user: McpUserContext
	emailVerified: boolean
	suspended: boolean
	passwordChangedAt: string | null
}

function buildBaseUserFromGrant(
	grantProps: NonNullable<McpOAuthGrantProps>,
	userId: PersonId,
): McpUserContext {
	const email =
		typeof grantProps.email === 'string' ? grantProps.email.trim() : ''
	const displayName =
		typeof grantProps.displayName === 'string'
			? grantProps.displayName
			: email
				? displayNameFromEmail(email)
				: 'user'

	return {
		userId,
		email,
		displayName,
		...(typeof grantProps.username === 'string'
			? { username: grantProps.username }
			: {}),
	}
}

/**
 * Build the MCP caller user context from OAuth grant props.
 *
 * Account identity and RBAC always resolve through the grant's stable
 * `userId` (`users.stable_user_id`). D1 lookup failures fail closed; grant
 * profile fields only fill missing values after the authoritative row resolves.
 */
export function personIdFromGrantProps(
	grantProps: McpOAuthGrantProps,
): PersonId | null {
	if (!grantProps || typeof grantProps.userId !== 'string') {
		return null
	}
	const trimmedUserId = grantProps.userId.trim()
	if (!trimmedUserId) return null
	return personIdFromStored(trimmedUserId)
}

function grantUserStatement(env: Env, userId: PersonId) {
	return env.APP_DB.prepare(
		`SELECT id, email, username, display_name, stable_user_id,
			personal_org_id, deleting_at, email_verified_at, suspended_at,
			password_changed_at
		 FROM users
		 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
	).bind(userId)
}

async function contextFromGrantUserRow(input: {
	env: Env
	grantProps: NonNullable<McpOAuthGrantProps>
	userId: PersonId
	row: GrantUserRow | null
}): Promise<McpAuthUserContext | null> {
	const { row } = input
	if (!row || row.deleting_at) return null
	const { roles, permissions } = await getUserRolesAndPermissions(
		input.env.APP_DB,
		row.id,
	)
	return contextFromGrantUserRowAndRoles({ ...input, row, roles, permissions })
}

function contextFromGrantUserRowAndRoles(input: {
	grantProps: NonNullable<McpOAuthGrantProps>
	userId: PersonId
	row: GrantUserRow
	roles: NonNullable<McpUserContext['roles']>
	permissions: NonNullable<McpUserContext['permissions']>
}): McpAuthUserContext {
	const { row, userId, roles, permissions } = input
	const baseUser = buildBaseUserFromGrant(input.grantProps, userId)

	const email = row.email.trim().toLowerCase()
	const usernameCandidate = row.username?.trim() ?? ''
	const username =
		usernameCandidate && !getUsernameFormatValidationError(usernameCandidate)
			? usernameCandidate
			: undefined
	const displayName =
		row.display_name?.trim() ||
		username ||
		(email ? displayNameFromEmail(email) : baseUser.displayName)

	return {
		user: {
			userId,
			email,
			displayName,
			personalOrgId: personalOrgIdFromUserRow({
				personal_org_id: row.personal_org_id,
				stable_user_id: row.stable_user_id,
			}),
			...(username ? { username } : {}),
			roles,
			permissions,
		},
		emailVerified: Boolean(row.email_verified_at),
		suspended: Boolean(row.suspended_at),
		passwordChangedAt: row.password_changed_at ?? null,
	}
}

export async function buildMcpUserContextFromGrantProps(
	env: Env,
	grantProps: McpOAuthGrantProps,
): Promise<McpAuthUserContext | null> {
	if (!grantProps) return null
	const userId = personIdFromGrantProps(grantProps)
	if (!userId) return null

	// Fail closed on transient D1 errors so a deleting or reassigned account can
	// never continue through stale OAuth grant metadata.
	try {
		const row = await grantUserStatement(env, userId).first<GrantUserRow>()
		return await contextFromGrantUserRow({ env, grantProps, userId, row })
	} catch (error) {
		console.error('Failed to load MCP auth user context:', error)
		throw error
	}
}

/**
 * {@link buildMcpUserContextFromGrantProps} plus the grant's org binding, read
 * in one D1 batch. A batch is a single transaction, so the user row every auth
 * gate checks and the membership row that decides the org role come from the
 * same snapshot: the overlap can never surface a membership that is older than
 * the identity it is paired with. `orgBinding` is null when the person is not
 * bound to the grant's org (or has no live personal-org membership).
 */
export async function buildMcpUserContextWithOrgBindingFromGrantProps(
	env: Env,
	grantProps: McpOAuthGrantProps,
): Promise<{
	context: McpAuthUserContext
	orgBinding: OrgBinding | null
} | null> {
	if (!grantProps) return null
	const userId = personIdFromGrantProps(grantProps)
	if (!userId) return null

	// Fail closed on transient D1 errors, same as the context-only loader.
	try {
		const plan: OrgBindingPlan = planOrgBindingFromGrantProps({
			db: env.APP_DB,
			personId: userId,
			grantProps,
		})
		const [userResult, ...bindingResults] = await env.APP_DB.batch([
			grantUserStatement(env, userId),
			...plan.statements,
		])
		const row = (userResult?.results[0] ?? null) as GrantUserRow | null
		const context = await contextFromGrantUserRow({
			env,
			grantProps,
			userId,
			row,
		})
		if (!context) return null
		const orgBinding = plan.resolve(
			bindingResults.map((result) => result.results[0] ?? null),
		)
		return { context, orgBinding }
	} catch (error) {
		console.error('Failed to load MCP auth user context:', error)
		throw error
	}
}

type McpAuthContextWithBinding = {
	context: McpAuthUserContext
	orgBinding: OrgBinding | null
}

function firstRow<T>(result: D1Result<unknown> | undefined): T | null {
	return (result?.results[0] ?? null) as T | null
}

function isMissingOrgsTableError(error: unknown) {
	return error instanceof Error && /no such table:\s*orgs/i.test(error.message)
}

/**
 * {@link buildMcpUserContextWithOrgBindingFromGrantProps} with the per-isolate
 * cache from mcp-auth-cache.ts in front of the roles and org-binding reads.
 *
 * Every call still reads the user row fresh (identity and every fail-closed
 * flag) together with the personal and bound orgs' `access_epoch` in one D1
 * transaction. When a cache entry for `accessToken` matches those epochs the
 * roles and binding come from the entry (one round trip); otherwise the roles
 * and binding statements run in that same transaction and the result is
 * stored (still one round trip, one more than a hit only when a stale entry
 * had to be discarded).
 */
export async function buildMcpAuthContextCached(
	env: Env,
	input: { grantProps: McpOAuthGrantProps; accessToken: string | null },
): Promise<McpAuthContextWithBinding | null> {
	const { grantProps, accessToken } = input
	if (!grantProps) return null
	const userId = personIdFromGrantProps(grantProps)
	if (!userId) return null
	const db = env.APP_DB
	const boundOrgId = readOrgIdFromGrantProps(grantProps)
	if (!boundOrgId) return null
	const readEpochs = (results: Array<D1Result<unknown>>) => {
		const personalOrg = firstRow<OrgEpochRow>(results[0])
		const boundOrg =
			boundOrgId === userId ? personalOrg : firstRow<OrgEpochRow>(results[1])
		return { personalOrg, boundOrg }
	}

	const cached = accessToken ? readMcpAuthCache(accessToken) : null
	try {
		const epochStatements = [
			orgEpochStatement(db, userId),
			...(boundOrgId === userId ? [] : [orgEpochStatement(db, boundOrgId)]),
		]
		if (cached && cached.boundOrgId === boundOrgId) {
			const [userResult, ...epochResults] = await db.batch([
				grantUserStatement(env, userId),
				...epochStatements,
			])
			const row = firstRow<GrantUserRow>(userResult)
			if (!row || row.deleting_at) {
				evictMcpAuthCache(accessToken)
				return null
			}
			const { personalOrg, boundOrg } = readEpochs(epochResults)
			if (
				mcpAuthCacheEntryMatches({
					entry: cached,
					userRowId: row.id,
					boundOrgId,
					personalOrg,
					boundOrg,
				})
			) {
				return {
					context: contextFromGrantUserRowAndRoles({
						grantProps,
						userId,
						row,
						roles: cached.roles,
						permissions: cached.permissions,
					}),
					orgBinding: cached.orgBinding,
				}
			}
			evictMcpAuthCache(accessToken)
		}

		const plan: OrgBindingPlan = planOrgBindingFromGrantProps({
			db,
			personId: userId,
			grantProps,
		})
		const [userResult, ...rest] = await db.batch([
			grantUserStatement(env, userId),
			...epochStatements,
			...plan.statements,
			userRolesAndPermissionsByStableIdStatement(db, userId),
		])
		const row = firstRow<GrantUserRow>(userResult)
		if (!row || row.deleting_at) return null
		const epochResults = rest.slice(0, epochStatements.length)
		const bindingResults = rest.slice(
			epochStatements.length,
			epochStatements.length + plan.statements.length,
		)
		const rolesResult = rest[rest.length - 1]
		const { roles, permissions } = parseUserRolesAndPermissionRows(
			(rolesResult?.results ?? []) as Array<PermissionRow>,
		)
		const orgBinding = plan.resolve(
			bindingResults.map((result) => result.results[0] ?? null),
		)
		const context = contextFromGrantUserRowAndRoles({
			grantProps,
			userId,
			row,
			roles,
			permissions,
		})
		const { personalOrg, boundOrg } = readEpochs(epochResults)
		const personalOrgEpoch = orgEpochFromRow(personalOrg)
		const boundOrgEpoch = orgEpochFromRow(boundOrg)
		if (accessToken && personalOrgEpoch !== null && boundOrgEpoch !== null) {
			writeMcpAuthCache(accessToken, {
				userRowId: row.id,
				personalOrgEpoch,
				boundOrgId,
				boundOrgEpoch,
				roles,
				permissions,
				orgBinding,
			})
		}
		return { context, orgBinding }
	} catch (error) {
		if (isMissingOrgsTableError(error)) {
			// Pre-Teams test databases have no orgs table and nothing to key a
			// cache on; serve them the uncached read.
			return await buildMcpUserContextWithOrgBindingFromGrantProps(
				env,
				grantProps,
			)
		}
		console.error('Failed to load MCP auth user context:', error)
		throw error
	}
}
