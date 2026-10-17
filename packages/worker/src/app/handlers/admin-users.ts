import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
	redactEmailRecipient,
} from '#worker/audit-log.ts'
import {
	adminCreateUserWithPasswordSetup,
	AdminCreateUserError,
} from '#worker/identity/admin-user-creation.ts'
import { scheduleUserCreatedEvent } from '#worker/identity/schedule-user-lifecycle-event.ts'
import { loadAdminUserUsageData } from '#worker/admin/user-usage-data.ts'
import {
	clearAdminUserEmailOutboundPause,
	loadAdminUserByTarget,
	loadAdminUserRowByStableUserId,
	adminUserMatchesListFilters,
	loadAdminUsersData,
	loadRolesByUserIds,
	adminUserListItemFieldNames,
	updateAdminUserPlan,
	updateAdminUserSuspension,
	type AdminUserListItem,
} from '#worker/admin/users-data.ts'
import {
	AdminEmailVerificationError,
	markAdminUserEmailVerified,
	mintAdminEmailVerificationUrl,
} from '#worker/identity/email-verification-admin.ts'
import {
	AdminEmailDestinationVerificationError,
	markAdminEmailDestinationVerified,
} from '#worker/email/destination-verification-admin.ts'
import {
	parsePlanName,
	planNames,
	resolvePlanWrite,
	type PlanName,
} from '#universal/plans.ts'
import { requirePageUserWithRole } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	assignUserRole,
	removeAdminRolePreservingLastAdmin,
	removeUserRole,
	requireUserWithPermission,
} from '#app/permissions-server.ts'
import { type RoleName, roleNames } from '#universal/permissions.ts'
import { readNonEmptyTrimmedStringOrNumber } from '#app/request-body.ts'
import { type routes } from '#universal/routes.ts'
import { parsePersonId } from '@kody-internal/shared/owner-person-ids.ts'

export { adminUserListItemFieldNames, type AdminUserListItem }

export function createAdminHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const admin = await requirePageUserWithRole(request, env, 'admin')
			if (admin instanceof Response) {
				return admin
			}
			return Response.redirect(new URL('/admin/users', request.url), 302)
		},
	} satisfies Action<typeof routes.admin>
}

export function createAdminUsersHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const admin = await requirePageUserWithRole(request, env, 'admin')
			if (admin instanceof Response) {
				return admin
			}

			// The HTML page always seeds the first window; infinite scroll owns
			// later pages through the JSON API, so a stale `?page=N` link must
			// not anchor the list past the rows it can never load.
			const pageUrl = new URL(request.url)
			pageUrl.searchParams.delete('page')
			const pathStableUserId =
				typeof params === 'object' &&
				params !== null &&
				'stableUserId' in params &&
				typeof params.stableUserId === 'string'
					? params.stableUserId
					: undefined
			const adminUsers = await loadAdminUsersData(
				env,
				pageUrl.toString(),
				pathStableUserId,
			)

			return renderAppPage({
				request,
				env,
				title: 'Admin users',
				loaderData: { adminUsers },
			})
		},
	} satisfies Action<typeof routes.adminUsers | typeof routes.adminUserDetail>
}

export function createAdminUsersApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			try {
				if (request.method === 'GET') {
					await requireUserWithPermission(request, env, 'read:user:any')
					const payload = await loadAdminUsersData(env, request.url)
					return jsonResponse(payload)
				}

				if (request.method !== 'POST') {
					return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
				}

				const actor = await requireUserWithPermission(
					request,
					env,
					'update:user:any',
				)
				const body = await request.json().catch(() => null)
				if (!body || typeof body !== 'object') {
					return jsonResponse(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
				}

				const action = readNonEmptyTrimmedStringOrNumber(body, 'action')
				if (action === 'assign_role') {
					return handleAssignRoleAction({
						env,
						request,
						url,
						actor,
						body,
					})
				}
				if (action === 'remove_role') {
					return handleRemoveRoleAction({
						env,
						request,
						url,
						actor,
						body,
					})
				}
				if (action === 'update_plan') {
					return handleUpdatePlanAction({
						env,
						request,
						url,
						actor,
						body,
					})
				}
				if (action === 'suspend_user' || action === 'unsuspend_user') {
					return handleSuspensionAction({
						env,
						request,
						url,
						actor,
						body,
						suspended: action === 'suspend_user',
					})
				}
				if (action === 'resume_email_outbound') {
					return handleResumeEmailOutboundAction({
						env,
						request,
						url,
						actor,
						body,
					})
				}
				if (action === 'mark_email_verified') {
					return handleMarkEmailVerifiedAction({
						env,
						request,
						url,
						actor,
						body,
					})
				}
				if (action === 'mint_verify_url') {
					return handleMintVerifyUrlAction({
						env,
						request,
						url,
						actor,
						body,
					})
				}
				if (action === 'mark_email_destination_verified') {
					return handleMarkEmailDestinationVerifiedAction({
						env,
						request,
						url,
						actor,
						body,
					})
				}
				if (action === 'create_user') {
					return handleCreateUserAction({
						env,
						request,
						url,
						actor,
						body,
					})
				}

				return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
			} catch (error) {
				if (error instanceof Response) {
					return error
				}
				throw error
			}
		},
	} satisfies Action<typeof routes.adminUsersApi>
}

/**
 * Per-user usage drill-down for the admin users page. Loads usage for
 * exactly one account (the selected one) instead of a whole page of
 * users, so the cost per request stays constant as the user base grows.
 */
export function createAdminUserUsageApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			try {
				await requireUserWithPermission(request, env, 'read:user:any')
				const url = new URL(request.url)
				const stableUserId = parsePersonId(url.searchParams.get('stableUserId'))
				if (!stableUserId) {
					return jsonResponse(
						{ ok: false, error: 'stableUserId is required.' },
						400,
					)
				}
				const payload = await loadAdminUserUsageData(env, stableUserId)
				if (!payload) {
					return jsonResponse({ ok: false, error: 'User not found.' }, 404)
				}
				return jsonResponse(payload)
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	} satisfies Action<typeof routes.adminUserUsageApi>
}

async function handleAssignRoleAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithPermission>>
	body: object
}) {
	const targetStableUserId = readStableUserIdField(input.body)
	const roleName = readRoleName(input.body, 'role')
	if (!targetStableUserId) {
		return jsonResponse(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}
	if (!roleName) {
		return jsonResponse({ ok: false, error: 'Role is required.' }, 400)
	}

	const targetUser = await loadAdminUserRowByStableUserId(
		input.env.APP_DB,
		targetStableUserId,
	)
	if (!targetUser) {
		return jsonResponse({ ok: false, error: 'User not found.' }, 404)
	}

	await assignUserRole({
		db: input.env.APP_DB,
		userId: targetUser.id,
		roleName,
	})

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'assign_role',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: `target_stable_user_id=${targetStableUserId};role=${roleName}`,
	})

	return buildMutationResponse(input.env, input.request.url, targetStableUserId)
}

/**
 * Mutation responses carry the refreshed page slice plus the updated target
 * user, because with infinite scroll the target may live outside the first
 * page and the client patches it in place instead of resetting the list.
 */
async function buildMutationResponse(
	env: Env,
	requestUrl: string,
	targetStableUserId: string,
	extra: { verifyUrl?: string | null; verifyUrlExpiresAt?: number | null } = {},
) {
	const [payload, updatedUser] = await Promise.all([
		loadAdminUsersData(env, requestUrl),
		loadAdminUserByTarget(env.APP_DB, { stableUserId: targetStableUserId }),
	])
	return jsonResponse({ ...payload, updatedUser, ...extra })
}

async function handleRemoveRoleAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithPermission>>
	body: object
}) {
	const targetStableUserId = readStableUserIdField(input.body)
	const roleName = readRoleName(input.body, 'role')
	if (!targetStableUserId) {
		return jsonResponse(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}
	if (!roleName) {
		return jsonResponse({ ok: false, error: 'Role is required.' }, 400)
	}

	const targetUser = await loadAdminUserRowByStableUserId(
		input.env.APP_DB,
		targetStableUserId,
	)
	if (!targetUser) {
		return jsonResponse({ ok: false, error: 'User not found.' }, 404)
	}

	if (roleName === 'admin') {
		// The last-admin check runs inside the DELETE statement itself so two
		// concurrent removals cannot both pass a stale count and leave the
		// deployment with zero admins.
		const { removed } = await removeAdminRolePreservingLastAdmin({
			db: input.env.APP_DB,
			userId: targetUser.id,
		})
		if (!removed) {
			const targetRoles = await loadRolesByUserIds(input.env.APP_DB, [
				targetUser.id,
			])
			const targetStillAdmin = (targetRoles.get(targetUser.id) ?? []).includes(
				'admin',
			)
			if (targetStillAdmin) {
				const requestIp = getRequestIp(input.request) ?? undefined
				void logAuditEvent({
					db: auditDatabaseFromEnv(input.env),
					category: 'admin',
					action: 'remove_role',
					result: 'failure',
					email: input.actor.email,
					ip: requestIp,
					path: input.url.pathname,
					reason: 'last_admin',
				})
				return jsonResponse(
					{
						ok: false,
						error:
							'Cannot remove the admin role from the last remaining admin account.',
					},
					409,
				)
			}
			// The target did not have the admin role; removal is an idempotent
			// no-op, matching non-admin role removal behavior.
		}
	} else {
		await removeUserRole({
			db: input.env.APP_DB,
			userId: targetUser.id,
			roleName,
		})
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'remove_role',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: `target_stable_user_id=${targetStableUserId};role=${roleName}`,
	})

	return buildMutationResponse(input.env, input.request.url, targetStableUserId)
}

async function handleUpdatePlanAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithPermission>>
	body: object
}) {
	const targetStableUserId = readStableUserIdField(input.body)
	if (!targetStableUserId) {
		return jsonResponse(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}
	const planUpdate = readPlanUpdate(input.body)
	if (!planUpdate.ok) {
		return jsonResponse(
			{
				ok: false,
				error: 'Plan must be one of the known plan names, or null for free.',
			},
			400,
		)
	}

	const updatedUser = await updateAdminUserPlan(input.env.APP_DB, {
		stableUserId: targetStableUserId,
		plan: planUpdate.plan,
	})
	if (!updatedUser) {
		return jsonResponse({ ok: false, error: 'User not found.' }, 404)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'update_plan',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: `target_stable_user_id=${targetStableUserId};plan=${planUpdate.plan}`,
	})

	return buildMutationResponse(input.env, input.request.url, targetStableUserId)
}

/**
 * Set or clear the platform suspension. Unlike a community ban (community
 * surfaces only), suspension is fail-closed at the browser-session, MCP,
 * and email chokepoints.
 */
async function handleSuspensionAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithPermission>>
	body: object
	suspended: boolean
}) {
	const targetStableUserId = readStableUserIdField(input.body)
	if (!targetStableUserId) {
		return jsonResponse(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}
	if (input.suspended && targetStableUserId === input.actor.mcpUser.userId) {
		return jsonResponse(
			{ ok: false, error: 'You cannot suspend your own account.' },
			400,
		)
	}

	const updatedUser = await updateAdminUserSuspension(input.env.APP_DB, {
		stableUserId: targetStableUserId,
		suspended: input.suspended,
	})
	if (!updatedUser) {
		return jsonResponse({ ok: false, error: 'User not found.' }, 404)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: input.suspended ? 'suspend_user' : 'unsuspend_user',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: `target_stable_user_id=${targetStableUserId}`,
	})

	return buildMutationResponse(input.env, input.request.url, targetStableUserId)
}

/**
 * Clear an automatic outbound-email pause (set by the delivery-event
 * abuse monitor) after reviewing the account's delivery history.
 */
async function handleResumeEmailOutboundAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithPermission>>
	body: object
}) {
	const targetStableUserId = readStableUserIdField(input.body)
	if (!targetStableUserId) {
		return jsonResponse(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}

	const updatedUser = await clearAdminUserEmailOutboundPause(input.env.APP_DB, {
		stableUserId: targetStableUserId,
	})
	if (!updatedUser) {
		return jsonResponse({ ok: false, error: 'User not found.' }, 404)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'resume_email_outbound',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: `target_stable_user_id=${targetStableUserId}`,
	})

	return buildMutationResponse(input.env, input.request.url, targetStableUserId)
}

async function handleMarkEmailVerifiedAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithPermission>>
	body: object
}) {
	const targetStableUserId = readStableUserIdField(input.body)
	if (!targetStableUserId) {
		return jsonResponse(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}

	try {
		await markAdminUserEmailVerified(input.env.APP_DB, {
			stableUserId: targetStableUserId,
		})
	} catch (error) {
		if (
			error instanceof AdminEmailVerificationError &&
			error.code === 'not_found'
		) {
			return jsonResponse({ ok: false, error: 'User not found.' }, 404)
		}
		throw error
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'mark_email_verified',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: `target_stable_user_id=${targetStableUserId}`,
	})

	return buildMutationResponse(input.env, input.request.url, targetStableUserId)
}

async function handleMintVerifyUrlAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithPermission>>
	body: object
}) {
	const targetStableUserId = readStableUserIdField(input.body)
	if (!targetStableUserId) {
		return jsonResponse(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}

	let minted: Awaited<ReturnType<typeof mintAdminEmailVerificationUrl>>
	try {
		minted = await mintAdminEmailVerificationUrl({
			db: input.env.APP_DB,
			appBaseUrl: new URL(input.request.url).origin,
			target: { stableUserId: targetStableUserId },
		})
	} catch (error) {
		if (error instanceof AdminEmailVerificationError) {
			return jsonResponse(
				{ ok: false, error: error.message },
				error.code === 'not_found' ? 404 : 400,
			)
		}
		throw error
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'mint_verify_url',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: `target_stable_user_id=${targetStableUserId}`,
	})

	return buildMutationResponse(
		input.env,
		input.request.url,
		targetStableUserId,
		{
			verifyUrl: minted.verifyUrl,
			verifyUrlExpiresAt: minted.expiresAt,
		},
	)
}

async function handleMarkEmailDestinationVerifiedAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithPermission>>
	body: object
}) {
	const targetStableUserId = readStableUserIdField(input.body)
	if (!targetStableUserId) {
		return jsonResponse(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}
	const destinationEmail =
		readNonEmptyTrimmedStringOrNumber(input.body, 'destinationEmail') ?? ''
	if (!destinationEmail) {
		return jsonResponse(
			{ ok: false, error: 'Destination email is required.' },
			400,
		)
	}

	let marked: Awaited<ReturnType<typeof markAdminEmailDestinationVerified>>
	try {
		marked = await markAdminEmailDestinationVerified({
			db: input.env.APP_DB,
			target: { stableUserId: targetStableUserId },
			destinationEmail,
		})
	} catch (error) {
		if (error instanceof AdminEmailDestinationVerificationError) {
			return jsonResponse(
				{ ok: false, error: error.message },
				error.code === 'not_found' ? 404 : 400,
			)
		}
		throw error
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'mark_email_destination_verified',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: `target_stable_user_id=${targetStableUserId};destination=${marked.destination.email}`,
	})

	return buildMutationResponse(input.env, input.request.url, targetStableUserId)
}

async function handleCreateUserAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithPermission>>
	body: object
}) {
	const email = readNonEmptyTrimmedStringOrNumber(input.body, 'email') ?? ''
	const username = readNonEmptyTrimmedStringOrNumber(input.body, 'username')

	try {
		const createdUser = await adminCreateUserWithPasswordSetup({
			db: input.env.APP_DB,
			env: input.env,
			email,
			username,
			setupLinkOrigin: input.url,
		})
		scheduleUserCreatedEvent({
			env: input.env,
			user: {
				id: createdUser.stableUserId,
				username: createdUser.username,
				email: createdUser.email,
			},
			source: 'admin',
		})
		const requestIp = getRequestIp(input.request) ?? undefined
		void logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'admin',
			action: 'create_user',
			result: 'success',
			email: input.actor.email,
			ip: requestIp,
			path: input.url.pathname,
			reason: [
				`actor_stable_user_id=${input.actor.mcpUser.userId}`,
				`target_stable_user_id=${createdUser.stableUserId}`,
				`target_email=${redactEmailRecipient(createdUser.email)}`,
			].join(';'),
		})

		const { userId: _userId, ...boundaryUser } = createdUser
		const createdListItem = await loadAdminUserByTarget(input.env.APP_DB, {
			stableUserId: createdUser.stableUserId,
		}).catch(() => null)
		const createdUserInFilteredList = createdListItem
			? await adminUserMatchesListFilters(
					input.env,
					input.request.url,
					createdUser.stableUserId,
				).catch(() => false)
			: false
		try {
			const payload = await loadAdminUsersData(input.env, input.request.url)
			return jsonResponse({
				...payload,
				updatedUser: createdListItem,
				createdUser: boundaryUser,
				createdUserInFilteredList,
			})
		} catch (error) {
			// The account and one-time setup link already exist. A list refresh
			// failure must not become a 500 that drops that link.
			console.warn('admin-users-create-list-refresh-failed', error)
			return jsonResponse({
				ok: true,
				users: [],
				selectedUser: null,
				page: 1,
				pageSize: 20,
				total: 0,
				availableRoles: [...roleNames],
				availablePlans: [...planNames],
				updatedUser: createdListItem,
				createdUser: boundaryUser,
				createdUserInFilteredList,
				listRefreshFailed: true,
			})
		}
	} catch (error) {
		const message =
			error instanceof Error ? error.message : 'Unable to create user.'
		const requestIp = getRequestIp(input.request) ?? undefined
		void logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'admin',
			action: 'create_user',
			result: 'failure',
			email: input.actor.email,
			ip: requestIp,
			path: input.url.pathname,
			reason:
				error instanceof AdminCreateUserError ? error.code : 'create_failed',
		})
		return jsonResponse(
			{
				ok: false,
				error: message,
				code: error instanceof AdminCreateUserError ? error.code : undefined,
			},
			error instanceof AdminCreateUserError &&
				(error.code === 'email_exists' || error.code === 'username_exists')
				? 409
				: error instanceof AdminCreateUserError
					? 400
					: 500,
		)
	}
}

/**
 * Read the requested plan value: a known plan name sets it; explicit null
 * (and empty string) map to `free` (the normal default). Writers never
 * persist NULL. Missing key or unknown plan strings are rejected.
 */
function readPlanUpdate(
	body: object,
): { ok: true; plan: PlanName } | { ok: false } {
	if (!('plan' in body)) return { ok: false }
	const value = (body as Record<string, unknown>).plan
	if (value === null) return { ok: true, plan: resolvePlanWrite(null) }
	if (typeof value === 'string') {
		const trimmed = value.trim()
		if (!trimmed) return { ok: true, plan: resolvePlanWrite(null) }
		const plan = parsePlanName(trimmed)
		if (plan) return { ok: true, plan }
	}
	return { ok: false }
}

function isRoleName(value: string): value is RoleName {
	return (roleNames as ReadonlyArray<string>).includes(value)
}

function readRoleName(body: object, key: string): RoleName | null {
	const value = readNonEmptyTrimmedStringOrNumber(body, key)
	return value && isRoleName(value) ? value : null
}

function readStableUserIdField(body: object): string | null {
	return parsePersonId((body as Record<string, unknown>).stableUserId)
}
